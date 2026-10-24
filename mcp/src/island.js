const ALLOWED_ORIGIN = 'https://chiuchangru.github.io';
const CORS = {'access-control-allow-origin':ALLOWED_ORIGIN,'access-control-allow-methods':'GET, OPTIONS','access-control-allow-headers':'x-pin, authorization','vary':'Origin','cache-control':'no-store, private','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
function response(body,status=200){return new Response(JSON.stringify(body),{status,headers:{...CORS,'content-type':'application/json; charset=utf-8'}})}
function config(){
 return [
 ['t-hydro',['親水','hydrophilic','lubricious'],[36,16,65,46]],
 ['t-anti-enc',['抗結痂','encrustation','人工尿液'],[101,112,113,114]],
 ['t-braid',['編織','braid'],[]],['t-anti-bac',['抗菌','antimicrobial','biofilm'],[]],
 ['t-laser',['雷射','laser','打孔','印刷'],[]],['t-coil',['繞簧','coil','長鞘'],[]],
 ['t-extrude',['變徑','異型','押出','extrusion'],[]],['t-balloon',['球囊','balloon'],[76]],
 ['angio-cath',['血管攝影導管'],[]],['sheath',['血管鞘','sheath'],[]],['long-sheath',['長鞘','長血管鞘'],[]],
 ['micro-cath',['微導管','microcatheter'],[]],['hp-syringe',['高壓注射筒'],[98,57]],['manifold',['多歧管','高壓連接管','manifold'],[]],
 ['blood-line',['血液迴路','血液回路','blood line'],[]],['fistula-needle',['透析穿刺針','瘻管針'],[]],
 ['hd-cath',['透析導管','HD導管','HD 導管'],[25,29,30]],['cvc',['中心靜脈導管','CVC'],[99]],['suction',['抽痰管'],[]],
 ['dj',['DJ管','DJ 管','雙J管'],[]],['foley',['導尿管','foley'],[]],['pigtail',['pigtail','腎引流'],[36]],
 ['balloon',['球囊','balloon'],[76]],['iv-bag',['藥用軟袋'],[]],['ext-line',['輸液連接管'],[]],['biopsy',['檢體針','切片針','biopsy'],[19,106,115]]
 ].map(([id,keywords,folders])=>({id,keywords,folders}));
}
const SOURCES=[
 {tile:'materials',keywords:['原料','材料','樹脂','塗層','tpu','pebax','etfe','polymer','resin','coating']},
 {tile:'components',keywords:['線材','薄膜','接頭','零件','wire','film','connector','component']},
 {tile:'equipment',keywords:['設備','押出','編織','雷射','熱焊','模具','equipment','extrusion','braiding','laser','mold']}
];
function matches(text,keywords){const lower=String(text).toLowerCase();return keywords.some(k=>lower.includes(k.toLowerCase()))}
function safeBase(value,fallback){try{const url=new URL(value||fallback);return url.protocol==='https:'?url.origin:fallback}catch{return fallback}}
export async function handleIsland(request,env,authorize){
 const origin=request.headers.get('origin');
 if(origin&&origin!==ALLOWED_ORIGIN)return new Response('Forbidden',{status:403,headers:{'cache-control':'no-store','vary':'Origin'}});
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});
 if(request.method!=='GET')return response({error:'method not allowed'},405);
 const auth=await authorize(request,env);if(!auth.ok)return response({error:'unauthorized'},401);
 try{
 const db=env.DB_FIELDLOG,fieldBase=safeBase(env.FIELDLOG_URL,'https://fieldlog.gogoyankee.workers.dev'),exBase=safeBase(env.MEDTEC_URL,'https://medtec-2026.gogoyankee.workers.dev');
 const definitions=config();
 // SQL counts the union of keyword matches and folder subtrees without truncating it.
 const queries=definitions.map(d=>{
  const folders=d.folders.length?d.folders.map(()=>'?').join(','):'NULL';
  const keyword=d.keywords.map(()=>`(instr(lower(COALESCE(e.title,'')||' '||COALESCE(e.body,'')||' '||COALESCE(e.fields_json,'')||' '||COALESCE(f.name,'')),?)>0 OR EXISTS(SELECT 1 FROM attachments a WHERE a.entry_id=e.id AND instr(lower(COALESCE(a.filename,'')||' '||COALESCE(a.transcript,'')||' '||COALESCE(a.ocr_text,'')),?)>0))`).join(' OR ');
  const sql=`WITH RECURSIVE scope(id) AS (SELECT id FROM folders WHERE id IN (${folders}) AND COALESCE(deleted_at,'')='' UNION SELECT f2.id FROM folders f2 JOIN scope s ON f2.parent_id=s.id WHERE COALESCE(f2.deleted_at,'')='') SELECT e.id,e.title,f.name AS folder_name,f.type AS folder_type,COUNT(*) OVER() AS match_count FROM entries e LEFT JOIN folders f ON f.id=e.folder_id WHERE COALESCE(e.deleted_at,'')='' AND (f.id IS NULL OR COALESCE(f.deleted_at,'')='') AND (e.folder_id IN (SELECT id FROM scope) OR ${keyword}) ORDER BY e.id DESC LIMIT 8`;
  return db.prepare(sql).bind(...d.folders,...d.keywords.flatMap(k=>[k.toLowerCase(),k.toLowerCase()]));
 });
 const results=await db.batch(queries);
 const record=r=>({title:r.title||'未命名紀錄',url:fieldBase+'/?entry='+encodeURIComponent(r.id)});
 const items=definitions.map((d,i)=>{const rows=results[i].results||[];return{id:d.id,count:Number(rows[0]?.match_count||0),latest:rows.slice(0,d.id.startsWith('t-')?5:3).map(record),standards:rows.filter(r=>/標準|標規|規範|standard/i.test((r.folder_type||'')+' '+(r.folder_name||''))).slice(0,3).map(record)}});
 const vendors=[];
 const folderRows=await db.prepare("SELECT id,name,type FROM folders WHERE COALESCE(deleted_at,'')='' ORDER BY id DESC").all();
 for(const source of SOURCES)for(const f of folderRows.results||[])if(matches(f.name,source.keywords)&&/廠商|供應|展商|拜訪|supplier|vendor/i.test(f.type+' '+f.name))vendors.push({tile:source.tile,title:f.name,url:fieldBase+'/?folder='+encodeURIComponent(f.id)});
 // Optional exhibitor data cannot prevent record lookup from working.
 try{const raw=await env.MEDTEC.fetch('https://medtec.internal/data/exhibitors.json');if(raw.ok){const data=await raw.json();for(const source of SOURCES){let count=0;for(const ex of data.exhibitors||[]){if(count>=12)break;const text=[ex.name_zh,ex.name_en,ex.description,...(ex.products||[]),...(ex.tags||[])].join(' ');if(matches(text,source.keywords)){vendors.push({tile:source.tile,title:ex.name_zh||ex.name_en||'展商資料',url:exBase+'/?ex='+encodeURIComponent(ex.id)});count++}}}}}catch{}
 return response({items,vendors});
 }catch{return response({error:'knowledge source unavailable'},503)}
}
