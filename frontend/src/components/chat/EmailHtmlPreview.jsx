import { useMemo } from "react";

const logo = "https://workflow-automation-44201.web.app/brand/agentic-email-mark.png";

/** Display-only projection. Never replace the immutable send arguments with
 * this document. Isolate email markup from the app and prevent remote tracking. */
function previewDocument(html) {
  if (typeof html !== "string" || !html.trim() || html.length > 200000) return null;
  try {
    const document = new DOMParser().parseFromString(html, "text/html");
    document.querySelectorAll("script,iframe,frame,frameset,object,embed,applet,base,link,meta,form,input,button,select,textarea,video,audio,source,track,svg,math,template").forEach(element => element.remove());
    for (const element of document.querySelectorAll("*")) {
      const productLogo = element.tagName === "IMG" && element.getAttribute("src") === logo;
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith("on") || ["href", "src", "srcset", "srcdoc", "action", "formaction", "target", "ping", "download", "background", "autofocus", "tabindex", "contenteditable"].includes(name)) element.removeAttribute(attribute.name);
      }
      if (element.tagName === "IMG") {
        if (productLogo) { element.setAttribute("src", logo); element.setAttribute("referrerpolicy", "no-referrer"); }
        else element.remove();
      }
    }
    // Only the fixed public product mark may load; arbitrary remote images,
    // attachment URLs and tracking pixels stay blocked in this preview.
    const policy = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src ${logo}; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light}body{margin:0;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>${document.head.innerHTML}</head><body>${document.body.innerHTML}</body></html>`;
  } catch { return null; }
}

export default function EmailHtmlPreview({ html }) {
  const source = useMemo(() => previewDocument(html), [html]);
  if (!source) return <p className="text-xs text-gray-500">HTML preview is unavailable. Review the plain-text message and exact source in Technical details.</p>;
  return <section aria-label="Email preview" className="space-y-2">
    <h4 className="text-xs font-semibold">Email preview</h4>
    <iframe title="Formatted email preview" sandbox="" referrerPolicy="no-referrer" srcDoc={source} className="h-[420px] w-full rounded-md border border-gray-200 bg-white sm:h-[520px] dark:border-gray-700" />
    <p className="text-[11px] leading-5 text-gray-500">Layout preview only. Links, forms and external images are disabled; the product logo is allowed. Your email app may display spacing differently. Review the recipients and message before confirming.</p>
  </section>;
}
