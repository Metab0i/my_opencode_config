/**
 * Poll-based permission/question auto-approver.
 *
 * In a headless server there is no TUI to answer `bash: ask` / `edit: ask` /
 * `question` requests, so `session.prompt` blocks forever. This polls pending
 * permission + question requests via client.permission.list / client.question.list
 * and replies deterministically.
 *
 * Bounded: rejects edits outside /tmp/** (and session dirs matching "ses_"),
 * approves everything else (read-only / innocuous) with reply "once".
 * Questions are answered with each question's first option label.
 *
 * Exports: startAutoApprover(client, dir) -> { stop() }
 */
export function startAutoApprover(client, dir) {
  let stopped = false
  const stop = () => {
    stopped = true
  }

  const approveOnce = async () => {
    if (stopped) return
    try {
      // Pending permissions
      const perms = await client.permission.list({ directory: dir })
      for (const p of perms.data ?? []) {
        const patterns = p.patterns ?? []
        const isEdit = p.permission === "edit"
        const outsideTmp =
          isEdit &&
          !patterns.every(
            (x) => String(x).startsWith("/tmp") || String(x).includes("ses_"),
          )
        const reply = outsideTmp ? "reject" : "once"
        await client.permission.reply({ requestID: p.id, reply, directory: dir })
        console.error(
          `[perm] ${reply === "reject" ? "REJECTED" : "approved"} "${p.permission}" ${JSON.stringify(patterns).slice(0, 60)}`,
        )
      }
      // Pending questions
      const qs = await client.question.list({ directory: dir })
      for (const q of qs.data ?? []) {
        // answer each question with its first option label (array-of-arrays shape)
        const answers = (q.questions ?? [])
          .map((qi) => [qi.options?.[0]?.label].filter(Boolean))
          .filter((a) => a.length > 0)
        try {
          await client.question.reply({ requestID: q.id, answers, directory: dir })
          console.error(`[question] answered with first options (${q.questions?.length ?? 0} q(s))`)
        } catch (e) {
          await client.question.reject({ requestID: q.id, directory: dir })
          console.error(`[question] rejected (reply failed: ${e?.message ?? e})`)
        }
      }
    } catch (e) {
      if (!stopped) console.error(`[perm] poll error: ${e?.message ?? e}`)
    }
  }

  let timer = null
  const loop = async () => {
    while (!stopped) {
      await approveOnce()
      await new Promise((r) => {
        timer = setTimeout(r, 500)
      })
    }
  }
  loop()

  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
