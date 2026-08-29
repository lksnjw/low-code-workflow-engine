import { useState } from "react";
import { Icon } from "@iconify/react";

/** Tokenise a line into bold/italic/code/link spans */
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
    // plain char
    const nextSpecial = rest.search(/`|\*\*/);
    if (nextSpecial === -1) {
      parts.push({ type: "text", text: rest });
      break;
    }
    parts.push({ type: "text", text: rest.slice(0, nextSpecial) });
    rest = rest.slice(nextSpecial);
  }
  return parts;
}

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

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
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

/** Parse raw markdown text into block tokens */
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
    if (pLines.length > 0) blocks.push({ type: "p", text: pLines.join(" ") });
  }
  return blocks;
}

function MessageMarkdown({ text }) {
  if (!text) return null;
  const blocks = tokenize(String(text));

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
        if (block.type === "ul") return (
          <ul key={idx} className="ml-4 list-none space-y-0.5">
            {block.items.map((item, ii) => (
              <li key={ii} className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span><InlineContent text={item} /></span>
              </li>
            ))}
          </ul>
        );
        if (block.type === "ol") return (
          <ol key={idx} className="ml-4 list-none space-y-0.5 counter-reset-[item]">
            {block.items.map((item, ii) => (
              <li key={ii} className="flex gap-2">
                <span className="min-w-[1.2rem] font-semibold text-primary">{ii + 1}.</span>
                <span><InlineContent text={item} /></span>
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
