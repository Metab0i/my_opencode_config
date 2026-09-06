/**
 * Live progress reporter (stage markers + token stream) via the global SSE event stream.
 *
 * The SDK's session.prompt returns a single RequestResult (not a stream), so this module
 * subscribes to client.global.event() (the global SSE stream) concurrently with the
 * blocking prompt call and filters events to our sessionID. It is a single shared
 * subscription across the whole run — started once, closed at the end.
 *
 * Feedback emitted (always, to stderr):
 *   - Stage markers: [i/n] label  (agent, model)  with per-step elapsed time.
 *   - Live activity: tool calls and reasoning/thinking happen in real time, so a step
 *     that is actually working shows what it is doing instead of looking stuck.
 *   - Token/cost accounting: per step (input/output/reasoning tokens + cost) and a
 *     running total, drawn from message.updated / step-finish events.
 * With `stream: true` (--stream), token- and reasoning-level text deltas are also written.
 *
 * Uses message.part.updated text parts to stream token deltas (diffing against the last
 * seen text per part id) and session.idle / session.error to detect step boundaries.
 * `message.updated` carries `info` (AssisstantMessage) with `tokens` + `cost` + `mode`,
 * and `step-finish` parts carry per-step `tokens` + `cost` + `reason`.
 *
 * Exports: ProgressReporter class
 *   reporter.start({ label, agent, model, index, total }) - begin a stage
 *   reporter.done(note)                                   - end the current stage
 *   reporter.summary()                                    - print cumulative token/cost totals
 *   reporter.close()                                      - stop the event stream (shutdown)
 */
export class ProgressReporter {
  constructor(client, { sessionID, directory, stream = false }) {
    this.client = client
    this.sessionID = sessionID
    this.directory = directory
    this.stream = stream
    this._lastText = new Map() // partID -> last full text seen
    this._seenTool = new Set() // partIDs of tool parts already reported
    this._stage = null // { label, agent, model, index, total, t0, ...counters }
    this._totals = { input: 0, output: 0, reasoning: 0, cost: 0, steps: 0 }
    this._streamPromise = null
    this._abort = null // AbortController for the SSE connection
    this._lastReasoningMark = 0
  }

  /**
   * Emit a stage marker and reset per-stage counters. The event stream is started lazily
   * on first use.
   */
  async start({ label, agent, model, index, total, maxToolCalls, maxRepeat, onLoop }) {
    this._stage = {
      label,
      agent: agent ?? "?",
      model: model ? `${model.providerID}/${model.modelID}` : "default",
      index: index ?? null,
      total: total ?? null,
      maxToolCalls: maxToolCalls ?? 40,
      maxRepeat: maxRepeat ?? 8,
      onLoop: onLoop ?? null,
      t0: Date.now(),
      tokens: undefined, // latest token snapshot for this stage
      toolCount: 0,
      reasoningTokens: 0,
      lastReasoningFlush: 0,
      repeat: new Map(), // `${tool}:${JSON.stringify(input)}` -> consecutive count
      lastCallKey: null, // key of the previous tool call (for consecutive-repeat tracking)
      loopAborted: false,
      onLoop: null, // callback(reason) invoked on loop detection (set by caller)
    }
    const nth = this._stage.index != null ? `[${this._stage.index}${this._stage.total != null ? `/${this._stage.total}` : ""}] ` : ""
    console.error(
      `\n${nth}${this._stage.label}  (agent=${this._stage.agent}, model=${this._stage.model})`,
    )
    if (!this._streamPromise) this._streamPromise = this._subscribe()
  }

  /** Mark the current stage complete and print its token/cost usage. */
  done(note = "") {
    if (!this._stage) return
    const s = this._stage
    const secs = ((Date.now() - s.t0) / 1000).toFixed(1)
    const usage = s.tokens ? this._fmtTokens(s.tokens) : fromCumulative(s)
    const extra = note ? ` ${note}` : ""
    console.error(`  └─ ${s.label} done in ${secs}s${usage}${extra}`)
    this._stage = null
  }

  /** Print cumulative totals across all stages. */
  summary() {
    const t = this._totals
    if (!t.steps) return
    console.error(
      `  Σ totals: ${t.steps} step(s) · in ${t.input} · out ${t.output} · ` +
        `reasoning ${t.reasoning} tokens · cost $${t.cost.toFixed(4)}`,
    )
  }

  /** Abort the SSE connection so the process can exit (idempotent). */
  close() {
    this._abort?.abort()
    this._abort = null
  }

  // -- token/cost helpers ---------------------------------------------------

  _fmtTokens(tk) {
    const p = []
    if (tk.input != null) p.push(`in ${tk.input}`)
    if (tk.output != null) p.push(`out ${tk.output}`)
    if (tk.reasoning) p.push(`reasoning ${tk.reasoning}`)
    if (tk.cache?.read || tk.cache?.write) p.push(`cache r${tk.cache.read}/w${tk.cache.write}`)
    let cost = ""
    if (tk.cost != null) cost = ` · $${Number(tk.cost).toFixed(4)}`
    return p.length ? ` · ${p.join(", ")}${cost}` : ""
  }

  /** Record a token snapshot for the current stage and roll it into totals. */
  _recordTokens(tk) {
    if (!tk) return
    const prev = this._stage?.tokens
    // Roll deltas into the running total so overlapping snapshots don't double-count.
    this._totals.input += Math.max(0, (tk.input ?? 0) - (prev?.input ?? 0))
    this._totals.output += Math.max(0, (tk.output ?? 0) - (prev?.output ?? 0))
    this._totals.reasoning += Math.max(0, (tk.reasoning ?? 0) - (prev?.reasoning ?? 0))
    if (tk.cost != null) this._totals.cost = Math.max(this._totals.cost, Number(tk.cost))
    if (this._stage) this._stage.tokens = tk
  }

  // -- event stream ---------------------------------------------------------

  async _subscribe() {
    try {
      const controller = new AbortController()
      this._abort = controller
      const res = await this.client.global.event({ signal: controller.signal })
      for await (const ev of res.stream) {
        if (controller.signal.aborted) break
        this._handle(ev)
      }
    } catch (e) {
      // AbortError on close is expected; ignore. Otherwise surface once.
      if (e?.name !== "AbortError" && !this._abort && this.client)
        console.error(`[progress] event stream error: ${e?.message ?? e}`)
    }
  }

  _handle(ev) {
    const payload = ev?.payload ?? ev
    const t = payload?.type
    const p = payload?.properties ?? {}
    // Only care about our session (global stream carries every session's events).
    if (p.sessionID && p.sessionID !== this.sessionID) return

    if (t === "message.updated") {
      const info = p.info
      if (info?.tokens) this._recordTokens(info.tokens)
      // First assistant message lands: log which model actually served it.
      if (this._stage && info?.agent && info?.modelID) {
        if (!this._stage._announcedModel) {
          this._stage._announcedModel = true
          // (model is already shown in the stage header; nothing extra needed here)
        }
      }
    } else if (t === "message.part.updated") {
      const part = p.part
      if (part?.type === "text" && typeof part.text === "string") {
        this._emitTextDelta(part)
      } else if (part?.type === "reasoning") {
        this._emitReasoning(part)
      } else if (part?.type === "tool") {
        this._emitTool(part)
      } else if (part?.type === "step-finish") {
        // definitive per-step token/cost snapshot
        if (part.tokens) {
          this._totals.steps++
          this._recordTokens({ ...part.tokens, cost: part.cost })
        }
      } else if (part?.type === "step-start") {
        this._stage && this._emitActivity(`step start`)
      }
    } else if (t === "session.error") {
      const err = p.error
      const msg = err?.data?.message ?? err?.message ?? JSON.stringify(err).slice(0, 200)
      console.error(`  └─ [error] ${msg}`)
    }
  }

  _emitTextDelta(part) {
    const prev = this._lastText.get(part.id)
    if (prev === undefined) {
      this._lastText.set(part.id, part.text)
      if (this.stream && part.text) process.stderr.write(part.text)
      return
    }
    const delta = part.text.slice(prev.length)
    if (delta && this.stream) process.stderr.write(delta)
    this._lastText.set(part.id, part.text)
  }

  /** Always show reasoning activity; stream the raw delta only under --stream. */
  _emitReasoning(part) {
    const prev = this._lastText.get(`r:${part.id}`) ?? ""
    const delta = part.text.slice(prev.length)
    if (delta && this.stream) process.stderr.write(delta)
    this._lastText.set(`r:${part.id}`, part.text)
    if (!this._stage) return
    this._stage.reasoningTokens += delta.length
    // Throttle the "thinking" heartbeats to ~once per 1.5s so they don't spam.
    const now = Date.now()
    if (now - this._stage.lastReasoningFlush > 1500) {
      this._stage.lastReasoningFlush = now
      this._emitActivity(`thinking… (~${this._stage.reasoningTokens}ch)`)
    }
  }

  /** Always show tool invocations, with a short summary of the args. */
  _emitTool(part) {
    if (!this._stage) return
    const name = part.tool ?? part.name ?? "tool"
    const state = part.state ?? {}

    // A tool part fires a `message.part.updated` event per state transition
    // (pending -> running -> completed); show it once, at the first informative state.
    if (this._seenTool.has(part.id)) return

    if (state.status === "pending") {
      // Not yet meaningful (input may still be assembling); wait for running/completed.
      return
    }
    this._seenTool.add(part.id)
    this._stage.toolCount++

    // Loop detection: (1) total tool-call budget, (2) repeated identical (tool, input).
    const input = state?.input
    let inputKey = input == null ? "" : typeof input === "string" ? input : JSON.stringify(input)
    const callKey = `${name}:${inputKey}`
    if (this._stage.lastCallKey === callKey) {
      this._stage.repeat.set(callKey, (this._stage.repeat.get(callKey) ?? 0) + 1)
    } else {
      this._stage.lastCallKey = callKey
      this._stage.repeat.set(callKey, 1)
    }
    const repeatCount = this._stage.repeat.get(callKey) ?? 1
    if (!this._stage.loopAborted) {
      if (this._stage.toolCount > this._stage.maxToolCalls) {
        this._abortLoopOrFlag(`exceeded maxToolCalls (${this._stage.maxToolCalls})`)
      } else if (repeatCount >= this._stage.maxRepeat) {
        this._abortLoopOrFlag(
          `repeated ${name} ${this._stage.maxRepeat}× (${truncate(inputKey, 60)})`,
        )
      }
    }

    const brief = summarizeToolInput(state)
    const arrow = state.status === "completed" ? "✓" : state.status === "error" ? "✗" : "▸"
    this._emitActivity(`${arrow} ${name}${brief ? ` · ${brief}` : ""}`)
  }

  /** Fire the loop callback once; fall back to a console warning if the caller set none. */
  _abortLoopOrFlag(reason) {
    this._stage.loopAborted = true
    if (this._stage.onLoop) {
      this._stage.onLoop(reason)
      return
    }
    console.error(`  └─ [loop] step "${this._stage.label}" suspected loop: ${reason}`)
  }

  _emitActivity(text) {
    if (!this._stage) return
    const secs = ((Date.now() - this._stage.t0) / 1000).toFixed(0).padStart(3)
    console.error(`    @${secs}s ${text}`)
  }
}

/** Best-effort one-line summary of a tool part's state (prefer title, then input). */
function summarizeToolInput(state) {
  const src =
    state?.title ?? state?.input ?? state?.raw ?? null
  if (src == null) return ""
  if (typeof src === "string") return truncate(src)
  try {
    return truncate(JSON.stringify(src))
  } catch {
    return ""
  }
}

function truncate(s, n = 90) {
  s = s.replace(/\s+/g, " ").trim()
  return s.length > n ? s.slice(0, n) + "…" : s
}

/** Fallback usage string when only cumulative counts are known. */
function fromCumulative(s) {
  if (!s.reasoningTokens && !s.toolCount) return ""
  const p = []
  if (s.reasoningTokens) p.push(`reasoning ~${s.reasoningTokens}ch`)
  if (s.toolCount) p.push(`${s.toolCount} tool call(s)`)
  return p.length ? ` · ${p.join(", ")}` : ""
}
