import { useState, useRef, useCallback } from "react";
import { Icon } from "@iconify/react";

// An LLM answer occasionally comes back as an HTML fragment instead of
// markdown (e.g. a query summary formatted with <h3>/<ul>/<li>) — the
// tokenizer below has no concept of HTML tags, so that would otherwise
// render as literal escaped text ("<h3>Sales</h3>" on screen, not a real
// heading). Detect that case up front and render it properly instead.
const HTML_FRAGMENT_RE = /^\s*<([a-z][a-z0-9]*)\b[^>]*>/i;
/*******************************************************************************
 * Function: looksLikeHtml
 *
 * Determines whether message text is an HTML fragment rather than markdown.
 ******************************************************************************/
function looksLikeHtml(text) {
  return HTML_FRAGMENT_RE.test(text);
}

/*******************************************************************************
 * Function: HtmlMessage
 *
 * Renders an HTML-fragment message safely — sandboxed in an iframe with
 * scripts disabled (sandbox=""), so nothing in AI-generated or ERP-sourced
 * content can execute. Auto-grows to fit its content since a sandboxed
 * iframe with no scripts can't report its own height back to the parent.
 ******************************************************************************/
function HtmlMessage({ html }) {
  const [height, setHeight] = useState(120);
  const iframeRef = useRef(null);

  const handleLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (doc?.documentElement) setHeight(Math.min(600, doc.documentElement.scrollHeight + 16));
  }, []);

  const styledHtml = `<style>body{margin:0;font:14px/1.5 -apple-system,sans-serif;color:#1f2937;}h1,h2,h3,h4{margin:0.6em 0 0.3em;}p{margin:0.4em 0;}ul,ol{margin:0.3em 0;padding-left:1.3em;}</style>${html}`;

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700">
      <iframe
        ref={iframeRef}
        title="Formatted response"
        srcDoc={styledHtml}
        // allow-same-origin only — lets the parent read scrollHeight to
        // auto-size the frame. allow-scripts is deliberately NOT granted,
        // so nothing in this content can execute regardless.
        sandbox="allow-same-origin"
        onLoad={handleLoad}
        style={{ height }}
        className="w-full transition-[height]"
      />
    </div>
  );
}

/** Tokenise a line into bold/italic/code/link spans */
/*******************************************************************************
 * Function: parseInline
 *
 * Parses inline for the MessageMarkdown module.
 ******************************************************************************/
function parseInline(text) {
  const parts = [];
  let rest = text;
  while (rest.length > 0) {
    // code span
    const codeMatch = /^`([^`]+)`/.exec(rest);
    if (codeMatch) {
      parts.push({ type: "code", text: codeMatch[1] });
      rest = rest.slice(codeMatch[0].length);
      continue;
    }
    // bold
    const boldMatch = /^\*\*(.+?)\*\*/.exec(rest);
    if (boldMatch) {
      parts.push({ type: "bold", text: boldMatch[1] });
      rest = rest.slice(boldMatch[0].length);
      continue;
    }
    // italic
    const italicMatch = /^\*(.+?)\*/.exec(rest);
    if (italicMatch) {
      parts.push({ type: "italic", text: italicMatch[1] });
      rest = rest.slice(italicMatch[0].length);
      continue;
    }
    // plain char — always advance at least 1 to avoid infinite loop on unmatched markers
    const nextSpecial = rest.search(/`|\*\*/);
    if (nextSpecial === -1) {
      parts.push({ type: "text", text: rest });
      break;
    }
    if (nextSpecial === 0) {
      parts.push({ type: "text", text: rest[0] });
      rest = rest.slice(1);
      continue;
    }
    parts.push({ type: "text", text: rest.slice(0, nextSpecial) });
    rest = rest.slice(nextSpecial);
  }
  return parts;
}

/*******************************************************************************
 * Function: InlineContent
 *
 * Performs the Inline Content operation on content for the MessageMarkdown module.
 ******************************************************************************/
function InlineContent({ text }) {
  const parts = parseInline(text);
  return (
    <>
      {parts.map((p, i) => {
        if (p.type === "code") return <code key={i} className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.8em] text-rose-600 dark:bg-gray-800 dark:text-rose-400">{p.text}</code>;
        if (p.type === "bold") return <strong key={i} className="font-semibold">{p.text}</strong>;
        if (p.type === "italic") return <em key={i}>{p.text}</em>;
        return <span key={i}>{p.text}</span>;
      })}
    </>
  );
}

/*******************************************************************************
 * Function: CodeBlock
 *
 * Performs the Code Block operation on block for the MessageMarkdown module.
 ******************************************************************************/
function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
/*******************************************************************************
 * Function: copy
 *
 * Performs the copy operation on the application for the MessageMarkdown module.
 ******************************************************************************/
  const copy = () => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="group relative my-3 rounded-xl border border-gray-200 bg-gray-900 dark:border-gray-700">
      <div className="flex items-center justify-between border-b border-gray-700 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-widest text-gray-400">{lang || "code"}</span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-gray-400 transition hover:bg-gray-700 hover:text-white"
        >
          <Icon icon={copied ? "mdi:check" : "mdi:content-copy"} className="h-3 w-3" />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-72 overflow-auto p-3 text-[11px] leading-5 text-green-300 scrollbar-thin">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Split a GFM table row on unescaped pipes, trimming the outer pipes */
/*******************************************************************************
 * Function: parseTableRow
 *
 * Performs the parse Table Row operation on table row for the MessageMarkdown module.
 ******************************************************************************/
function parseTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

/** A GFM header-separator row looks like | --- | :--: | ---: | */
/*******************************************************************************
 * Function: isTableSeparator
 *
 * Performs the is Table Separator operation on table separator for the MessageMarkdown module.
 ******************************************************************************/
function isTableSeparator(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
  const cells = parseTableRow(trimmed);
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

/** Parse raw markdown text into block tokens */
/*******************************************************************************
 * Function: tokenize
 *
 * Performs the tokenize operation on the application for the MessageMarkdown module.
 ******************************************************************************/
function tokenize(text) {
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fenceMatch = /^```(\w*)/.exec(line);
    if (fenceMatch) {
      const lang = fenceMatch[1];
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing ```
      blocks.push({ type: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    // heading
    const h3 = /^### (.+)/.exec(line);
    if (h3) { blocks.push({ type: "h3", text: h3[1] }); i++; continue; }
    const h2 = /^## (.+)/.exec(line);
    if (h2) { blocks.push({ type: "h2", text: h2[1] }); i++; continue; }
    const h1 = /^# (.+)/.exec(line);
    if (h1) { blocks.push({ type: "h1", text: h1[1] }); i++; continue; }

    // horizontal rule
    if (/^---+$/.test(line.trim())) { blocks.push({ type: "hr" }); i++; continue; }

    // blockquote
    if (/^> /.test(line)) { blocks.push({ type: "blockquote", text: line.slice(2) }); i++; continue; }

    // unordered list item
    const ulMatch = /^[-*] (.+)/.exec(line);
    if (ulMatch) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(lines[i].replace(/^[-*] /, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // ordered list item
    const olMatch = /^\d+\. (.+)/.exec(line);
    if (olMatch) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\. /, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // GFM table: a pipe row followed immediately by a valid separator row
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = parseTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    // empty line → skip
    if (line.trim() === "") { i++; continue; }

    // paragraph — gather consecutive non-blank non-special lines
    const pLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^[-*#>`]/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\d+\./.test(lines[i])
    ) {
      pLines.push(lines[i]);
      i++;
    }
    if (pLines.length > 0) {
      blocks.push({ type: "p", text: pLines.join(" ") });
    } else {
      // Unhandled line (e.g. bare `*`) — emit as plain text and always advance
      blocks.push({ type: "p", text: line });
      i++;
    }
  }
  return blocks;
}

/*******************************************************************************
 * Function: MessageMarkdown
 *
 * Performs the Message Markdown operation on markdown for the MessageMarkdown module.
 ******************************************************************************/
function MessageMarkdown({ text }) {
  if (!text) return null;
  const str = String(text);
  if (looksLikeHtml(str)) return <HtmlMessage html={str} />;
  const blocks = tokenize(str);

  return (
    <div className="space-y-2 text-sm leading-6">
      {blocks.map((block, idx) => {
        if (block.type === "h1") return <h1 key={idx} className="text-xl font-black text-gray-950 dark:text-white"><InlineContent text={block.text} /></h1>;
        if (block.type === "h2") return <h2 key={idx} className="mt-1 text-base font-bold text-gray-900 dark:text-white"><InlineContent text={block.text} /></h2>;
        if (block.type === "h3") return <h3 key={idx} className="text-sm font-semibold text-gray-800 dark:text-gray-100"><InlineContent text={block.text} /></h3>;
        if (block.type === "hr") return <hr key={idx} className="border-gray-200 dark:border-gray-700" />;
        if (block.type === "blockquote") return (
          <blockquote key={idx} className="border-l-2 border-primary pl-3 text-gray-600 italic dark:text-gray-400">
            <InlineContent text={block.text} />
          </blockquote>
        );
        if (block.type === "code") return <CodeBlock key={idx} lang={block.lang} code={block.code} />;
        if (block.type === "table") return (
          <div key={idx} className="my-2 overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
            <table className="w-full min-w-max border-collapse text-xs">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800/60">
                  {block.header.map((cell, ci) => (
                    <th key={ci} className="whitespace-nowrap border-b border-gray-200 px-3 py-2 text-left font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-200">
                      <InlineContent text={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, ri) => (
                  <tr key={ri} className="border-b border-gray-100 last:border-0 dark:border-gray-800">
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-3 py-2 text-gray-700 [font-variant-numeric:tabular-nums] dark:text-gray-300">
                        <InlineContent text={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        if (block.type === "ul") return (
          <ul key={idx} className="ml-4 list-none space-y-0.5">
            {block.items.map((item, ii) => (
              <li key={ii} className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span className="text-gray-800 dark:text-gray-200"><InlineContent text={item} /></span>
              </li>
            ))}
          </ul>
        );
        if (block.type === "ol") return (
          <ol key={idx} className="ml-4 list-none space-y-0.5">
            {block.items.map((item, ii) => (
              <li key={ii} className="flex gap-2">
                <span className="min-w-[1.2rem] font-semibold text-primary">{ii + 1}.</span>
                <span className="text-gray-800 dark:text-gray-200"><InlineContent text={item} /></span>
              </li>
            ))}
          </ol>
        );
        if (block.type === "p") return (
          <p key={idx} className="text-gray-800 dark:text-gray-200">
            <InlineContent text={block.text} />
          </p>
        );
        return null;
      })}
    </div>
  );
}

export default MessageMarkdown;
