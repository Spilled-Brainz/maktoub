import { createClient } from 'npm:@supabase/supabase-js@2'
import { parsePhoneNumberFromString } from 'npm:libphonenumber-js@1.11.20'
const url=Deno.env.get('SUPABASE_URL')!, key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})
const origins=new Set(['https://maktoub.app','https://www.maktoub.app'])
const cors=(origin:string|null)=>({'Content-Type':'application/json','Vary':'Origin',...(origin&&origins.has(origin)?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS','Access-Control-Allow-Headers':'authorization,content-type'}:{})})
const json=(body:unknown,status=200,origin:string|null=null)=>new Response(JSON.stringify(body),{status,headers:cors(origin)})
const statuses=new Set(['new','contacted','invited','confirmed','declined','attended'])
Deno.serve(async(req)=>{
 const origin=req.headers.get('origin')
 if(origin&&!origins.has(origin))return json({error:'Forbidden'},403,origin)
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors(origin)})
 if(!['GET','POST','PATCH'].includes(req.method))return json({error:'Method'},405,origin)
 const token=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'')
 if(!token)return json({error:'Sign in required'},401,origin)
 const {data:identity,error:authError}=await db.auth.getUser(token)
 if(authError||!identity.user)return json({error:'Sign in required'},401,origin)
 const {data:admin}=await db.from('maktoub_admins').select('role').eq('user_id',identity.user.id).maybeSingle()
 if(!admin||!['founder','event_staff'].includes(admin.role))return json({error:'No team access'},403,origin)
 const founder=admin.role==='founder'
 const eventId='wellness-connection-1010-2026'
 try{
  if(req.method==='GET'){
   const {data:events,error:evErr}=await db.from('maktoub_events').select('id,title,starts_at,city,status').order('created_at',{ascending:false})
   const {data:contacts,error:coErr}=await db.from('maktoub_event_contacts').select('id,event_id,person_id,status,assigned_to,notes,created_at,updated_at').order('created_at',{ascending:false}).limit(1000)
   if(evErr||coErr)throw evErr||coErr
   const ids=(contacts||[]).map(x=>x.person_id)
   const {data:eventPeople,error:epErr}=ids.length?await db.from('maktoub_people').select('id,full_name,normalized_phone,email,city,preferred_language,latest_source,latest_source_detail,consent_status,created_at').in('id',ids):{data:[],error:null}
   if(epErr)throw epErr
   const byId=new Map((eventPeople||[]).map(p=>[p.id,p]))
   const eventContacts=(contacts||[]).map(x=>({...x,person:byId.get(x.person_id)||null}))
   if(!founder)return json({role:admin.role,events,event_contacts:eventContacts},200,origin)
   const {data:people,error:pErr}=await db.from('maktoub_people').select('id,full_name,normalized_phone,email,city,gender,interest_matchmaking,interest_social,interest_events,stage,intake_status,next_action,next_action_at,latest_source,latest_source_detail,created_at').order('created_at',{ascending:false}).limit(1000)
   const {data:bookings,error:bErr}=await db.from('maktoub_intake_bookings').select('id,person_id,starts_at,ends_at,status,booking_email,created_at,requested_at,decision_at,payment_status').order('created_at',{ascending:false}).limit(500)
   if(pErr||bErr)throw pErr||bErr
   return json({role:admin.role,events,event_contacts:eventContacts,people,bookings},200,origin)
  }
  const body=await req.json()
  if(!body||typeof body!=='object')return json({error:'Invalid request'},400,origin)
  if(req.method==='PATCH'){
   if(typeof body.id!=='string'||!statuses.has(body.status))return json({error:'Invalid status'},400,origin)
   const notes=typeof body.notes==='string'?body.notes.trim().slice(0,1500):null
   const {data,error}=await db.from('maktoub_event_contacts').update({status:body.status,notes,updated_at:new Date().toISOString()}).eq('id',body.id).select('id,status,notes,updated_at').single()
   if(error)throw error
   return json({success:true,contact:data},200,origin)
  }
  const name=String(body.full_name||'').trim().slice(0,150)
  const rawPhone=String(body.phone||'').trim()
  const phone=parsePhoneNumberFromString(rawPhone, String(body.country_iso2||'SA').toUpperCase())
  if(!name||!phone?.isValid())return json({error:'Name and valid phone required'},400,origin)
  const email=typeof body.email==='string'?body.email.trim().slice(0,254):null
  const {data:upserted,error:upErr}=await db.rpc('upsert_maktoub_person',{
   p_full_name:name,p_normalized_phone:phone.number,p_email:email||null,p_source:'event',
   p_source_detail:'conference_outreach | '+eventId,
   p_interest_events:true,p_interest_social:true,p_consent_status:'unknown',
   p_internal_note:null
  })
  if(upErr||!upserted?.[0]?.person_id)throw upErr||new Error('Person save failed')
  const personId=upserted[0].person_id
  const {error:contactErr}=await db.from('maktoub_event_contacts').upsert({event_id:eventId,person_id:personId},{onConflict:'event_id,person_id',ignoreDuplicates:true})
  if(contactErr)throw contactErr
  return json({success:true,is_new:upserted[0].is_new},200,origin)
 }catch(error){console.error('maktoub-ops failed',error);return json({error:'Unable to complete request'},500,origin)}
})