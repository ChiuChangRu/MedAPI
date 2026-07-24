import previousWorker from "./worker-v40.js";

const LOAD_ARCHIVE_UI = ';(()=>{if(window.__fieldlogArchiveUiLoaderV41)return;window.__fieldlogArchiveUiLoaderV41=true;var tries=0;function load(){if(!window.__fieldlogPdfFolderButtonV40&&tries++<100){setTimeout(load,50);return}var s=document.createElement("script");s.src="/archive-ui-v41.js?v=41";s.async=false;document.head.appendChild(s)}load()})();';

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
    return new Response(`${await response.text()}\n${LOAD_ARCHIVE_UI}`, {
      status: response.status,
      headers,
    });
  },
};
