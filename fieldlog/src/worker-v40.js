import previousWorker from "./worker-v37.js";

const LOAD_PDF_EDITOR = ';(()=>{if(window.__fieldlogPdfEditorLoaderV40)return;window.__fieldlogPdfEditorLoaderV40=true;var a=document.createElement("script");a.src="/pdf-editor-v39.js?v=40";a.async=false;a.onload=function(){var b=document.createElement("script");b.src="/pdf-editor-folder-v40.js?v=40";b.async=false;document.head.appendChild(b)};document.head.appendChild(a)})();';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/app.js") {
      return previousWorker.fetch(request, env, ctx);
    }
    const response = await previousWorker.fetch(request, env, ctx);
    if (!response.ok) return response;
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/javascript; charset=utf-8");
    headers.set("cache-control", "no-store, max-age=0");
    return new Response(`${await response.text()}\n${LOAD_PDF_EDITOR}`, {
      status: response.status,
      headers,
    });
  },
};
