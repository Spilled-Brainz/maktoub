
const url=Deno.env.get("SUPABASE_URL")!;
const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const origins=new Set(["https://maktoub.app","https://www.maktoub.app","https://spilled-brainz.github.io"]);
const dbHeaders={"apikey":key,"Authorization":"Bearer "+key,"Content-Type":"application/json"};
Deno.serve(async(req)=>{
 const origin=req.headers.get("origin")||"";
 const headers={"Content-Type":"application/json","Vary":"Origin","Access-Control-Allow-Origin":origins.has(origin)?origin:"https://maktoub.app","Access-Control-Allow-Headers":"content-type","Access-Control-Allow-Methods":"POST,OPTIONS"};
 const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
 if(!origins.has(origin))return reply({error:"Forbidden"},403);
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 if(req.method!=="POST")return reply({error:"Method not allowed"},405);
 try{
  const raw=await req.text();if(raw.length>2048)return reply({error:"Request too large"},413);
  const body=JSON.parse(raw);
  if(body.website)return reply({ok:true});
  const email=String(body.email||"").trim().toLowerCase();
  if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return reply({error:"Enter a valid email."},400);
  const ip=req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()||"unknown";
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(key+ip));
  const hash=Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,"0")).join("");
  const since=new Date(Date.now()-3600000).toISOString();
  const limit=await fetch(url+"/rest/v1/investor_room_visitors?select=id&ip_hash=eq."+hash+"&created_at=gte."+encodeURIComponent(since)+"&limit=10",{headers:dbHeaders});
  if(!limit.ok)return reply({error:"Please try again shortly."},503);
  if((await limit.json()).length>=10)return reply({error:"Too many submissions. Please try later."},429);
  const save=await fetch(url+"/rest/v1/investor_room_visitors?on_conflict=email",{method:"POST",headers:{...dbHeaders,Prefer:"resolution=ignore-duplicates,return=representation"},body:JSON.stringify({email,ip_hash:hash})});
  if(!save.ok)return reply({error:"Unable to save. Please try again."},503);
  const rows=await save.json();
  if(rows.length){
   let status="not_configured";
   const bot=Deno.env.get("MAKTOUB_TELEGRAM_BOT_TOKEN"),chat=Deno.env.get("MAKTOUB_TELEGRAM_CHAT_ID");
   if(bot&&chat){
    try{
     const r=await fetch("https://api.telegram.org/bot"+bot+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chat,text:"Maktoub investor room — new email submission\n"+email+"\n"+new Date().toISOString()+"\nEmail supplied by visitor; identity not verified."}),signal:AbortSignal.timeout(8000)});
     status=r.ok&&(await r.json()).ok?"sent":"failed";
    }catch{status="failed";}
   }
   await fetch(url+"/rest/v1/investor_room_visitors?id=eq."+rows[0].id,{method:"PATCH",headers:dbHeaders,body:JSON.stringify({notification_status:status})});
  }
  return reply({ok:true});
 }catch{return reply({error:"Unable to submit. Please try again."},400);}
});
