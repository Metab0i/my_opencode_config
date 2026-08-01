import type { Plugin } from "@opencode-ai/plugin"

const MIN_COL_WIDTH = 3
const MAX_COL_WIDTH = 35

export const FormatTablesPlugin: Plugin = async () => {
  return {
    "experimental.text.complete": async (_input, output) => {
      const text = output?.text
      if (typeof text !== "string") return
      try {
        const fixed = formatTables(text)
        if (fixed !== text) output.text = fixed
      } catch (err) {
        void err
      }
    },
  }
}

const DELIMITER = /^\s*\|?\s*:?-+:?(\s*\|\s*:?-+:?)*\s*\|?\s*$/
const FENCE_OPEN = /^\s*(```|~~~)(.*)?$/
const FENCE_CLOSE = /^\s*(```|~~~)\s*$/

function splitCellsPreservingEscapes(line: string): string[] {
  const cells: string[] = []
  let cur = ""
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "\\" && line[i + 1] === "|") {
      cur += "\\|"
      i++
      continue
    }
    if (c === "|") {
      cells.push(cur)
      cur = ""
      continue
    }
    cur += c
  }
  cells.push(cur)
  return cells
}

function normalizeCell(raw: string): string {
  return raw
    .replace(/^\s+|\s+$/g, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\\\|/g, "|")
}

function parseTableCells(line: string, expected: number): string[] {
  let trimmed = line.replace(/^\s+|\s+$/g, "")
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1).replace(/^\s+/, "")
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) {
    trimmed = trimmed.slice(0, -1).replace(/\s+$/, "")
  }
  const raw = splitCellsPreservingEscapes(trimmed)
  const cells = raw.map(normalizeCell)

  if (cells.length > expected && cells[cells.length - 1] === "") cells.pop()
  if (cells.length > expected && cells[0] === "") cells.shift()

  if (cells.length > expected) {
    const head = cells.slice(0, expected - 1)
    head.push(cells.slice(expected - 1).join(" | "))
    return head
  }

  return cells
}

function determineEdgeStyle(header: string): { leading: boolean; trailing: boolean } {
  const leading = /^\s*\|/.test(header)
  const trailing = /\|\s*$/.test(header) && !/\|\\\s*$/.test(header)
  return { leading, trailing }
}

function parseRowCells(line: string): string[] {
  let trimmed = line.replace(/^\s+|\s+$/g, "")
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1).replace(/^\s+/, "")
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) {
    trimmed = trimmed.slice(0, -1).replace(/\s+$/, "")
  }
  const raw = splitCellsPreservingEscapes(trimmed)
  const cells = raw.map(normalizeCell)
  if (cells.length && cells[cells.length - 1] === "") cells.pop()
  if (cells.length && cells[0] === "") cells.shift()
  return cells
}

function countDelimiterCols(delim: string): number {
  let s = delim.replace(/^\s*\|/, "").replace(/\|\s*$/, "")
  if (!s.includes("|")) s = delim
  return s.split("|").filter((g) => /-/.test(g)).length || 1
}

export function formatTables(text: string): string {
  if (typeof text !== "string") return text as unknown as string
  const lines = text.split("\n")
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const header = lines[i]

    if (i + 1 < lines.length && header.includes("|") && DELIMITER.test(lines[i + 1]) && isTableRow(header)) {
      const delim = lines[i + 1]
      const style = determineEdgeStyle(header)
      let numCols = countDelimiterCols(delim)
      if (numCols < 1) {
        numCols = parseRowCells(header).length || 1
      }

      const rows: string[][] = []
      rows.push(parseRowCells(header))

      let rowCells: string[] = []
      i += 2

      while (i < lines.length) {
        const line = lines[i]
        const isBlank = line.replace(/^\s+|\s+$/g, "") === ""

        if (isBlank) {
          if (rowCells.length > 0) {
            rows.push(padRow(rowCells, numCols))
            rowCells = []
          }
          break
        }

        const startsNewTable =
          line.includes("|") &&
          i + 1 < lines.length &&
          DELIMITER.test(lines[i + 1]) &&
          isTableRow(line) &&
          rowCells.length === 0

        if (startsNewTable) break

        const incoming = parseTableCells(line, numCols)
        if (rowCells.length === 0) {
          rowCells = incoming
        } else {
          const first = rowCells[rowCells.length - 1]
          rowCells[rowCells.length - 1] = (first + " " + incoming[0]).replace(/\s+/g, " ").trim()
          rowCells = rowCells.concat(incoming.slice(1))
        }

        const endsTrailing = /\|\s*$/.test(line) && !/\\\|\s*$/.test(line)
        const complete = style.trailing
          ? rowCells.length >= numCols && endsTrailing
          : rowCells.length >= numCols
        if (complete) {
          rows.push(padRow(rowCells.slice(0, numCols), numCols))
          rowCells = []
        }
        i++
      }

      if (rowCells.length > 0) {
        rows.push(padRow(rowCells, numCols))
      }

      result.push(...renderCodeBlockTable(rows, numCols, style))
    } else {
      // Track fenced code blocks so we never re-format tables already inside ``` or ~~~.
      if (FENCE_OPEN.test(header)) {
        result.push(header)
        i++
        const fenceMarker = header.trim().split(/\s+/)[0].trim()
        while (i < lines.length) {
          result.push(lines[i])
          if (FENCE_CLOSE.test(lines[i]) && lines[i].trim().split(/\s+/)[0].trim() === fenceMarker) {
            i++
            break
          }
          i++
        }
        continue
      }
      result.push(header)
      i++
    }
  }

  return result.join("\n")
}

function isTableRow(line: string): boolean {
  const t = line.replace(/^\s+|\s+$/g, "")
  return t.startsWith("|") && t.endsWith("|") && t.split("|").length > 2
}

function padRow(cells: string[], numCols: number): string[] {
  let row = cells.slice()
  if (row.length > numCols) {
    const head = row.slice(0, numCols - 1)
    head.push(row.slice(numCols - 1).join(" | "))
    row = head
  }
  while (row.length < numCols) row.push("")
  return row.map((c) => (c == null ? "" : String(c)))
}

function displayWidth(text: string): number {
  const g: any = (globalThis as any).Bun
  if (g && typeof g.stringWidth === "function") return g.stringWidth(text)
  let w = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0
    w += code >= 0x1100 && code <= 0x115f ? 2 : code >= 0x2e80 && code <= 0xa3ff ? 2 : code >= 0xac00 && code <= 0xd7a3 ? 2 : code >= 0xf900 && code <= 0xfaff ? 2 : code >= 0xfe30 && code <= 0xfe4f ? 2 : code >= 0xff00 && code <= 0xff60 ? 2 : code >= 0xffe0 && code <= 0xffe6 ? 2 : 1
  }
  return w
}

function wrapWords(cell: string, width: number): string[] {
  if (width < 1) width = 1
  const words = cell.split(/\s+/).filter(Boolean)
  if (words.length === 0) return cell.trim() === "" ? [""] : [""]
  const lines: string[] = []
  let cur = ""
  for (const word of words) {
    if (word.length > width) {
      if (cur) {
        lines.push(cur)
        cur = ""
      }
      let rest = word
      while (rest.length > width) {
        lines.push(rest.slice(0, width))
        rest = rest.slice(width)
      }
      if (rest) cur = rest
      continue
    }
    if (!cur) {
      cur = word
    } else if (cur.length + 1 + word.length <= width) {
      cur += " " + word
    } else {
      lines.push(cur)
      cur = word
    }
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : [""]
}

function padRight(text: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(text))
  return text + " ".repeat(pad)
}

function renderCodeBlockTable(rows: string[][], numCols: number, style: { leading: boolean; trailing: boolean }): string[] {
  const widths: number[] = []
  for (let c = 0; c < numCols;c++) {
    let max = MIN_COL_WIDTH
    for (const row of rows) {
      const cell = row[c] ?? ""
      for (const line of wrapWords(cell, MAX_COL_WIDTH)) {
        const w = displayWidth(line)
        if (w > max) max = w
      }
    }
    widths.push(Math.min(MAX_COL_WIDTH, max))
  }

  const wrappedCells: string[][][] = rows.map((row) =>
    row.map((cell, c) => wrapWords(cell, widths[c])),
  )

  const border = () => "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+"

  const out: string[] = ["```", border()]
  wrappedCells.forEach((row, rowIdx) => {
    const height = Math.max(...row.map((lines) => lines.length))
    for (let line = 0; line < height; line++) {
      const parts: string[] = row.map((lines, c) => {
        const content = lines[line] ?? ""
        return padRight(content, widths[c])
      })
      out.push("| " + parts.join(" | ") + " |")
    }
    if (rowIdx === 0) {
      const dash = widths.map((w) => "-".repeat(w + 2))
      out.push("|" + dash.join("|") + "|")
    }
  })
  out.push(border(), "```")
  return out
}