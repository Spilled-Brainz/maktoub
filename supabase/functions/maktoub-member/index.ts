import { createClient } from 'npm:@supabase/supabase-js@2'
const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{autoRefreshToken:false,persistSession:false}})
const origins=new Set(['https://maktoub.app','https://www.maktoub.app'])
const headers=(origin:string|null)=>({'Content-Type':'application/json','Vary':'Origin',...(origin&&origins.has(origin)?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'authorization,content-type'}:{})})
const result=(data:unknown,status:number,origin:string|null)=>new Response(JSON.stringify(data),{status,headers:headers(origin)})
Deno.serve(async(req)=>{
 const origin=req.headers.get('origin')
 if(origin&&!origins.has(origin))return result({error:'Forbidden'},403,origin)
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:headers(origin)})
 if(!['GET','POST'].includes(req.method))return result({error:'Method'},405,origin)
 const token=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'')
 if(!token)return result({error:'Sign in required'},401,origin)
 const {data,error}=await db.auth.getUser(token)
 if(error||!data.user?.email||!data.user.email_confirmed_at)return result({error:'Verified email required'},401,origin)
 const {data:person,error:personError}=await db.from('maktoub_people').select('id,full_name,email,stage,intake_status,interest_matchmaking,interest_social,interest_events').ilike('email',data.user.email).maybeSingle()
 if(personError)return result({error:'Unable to load account'},500,origin)
 if(!person)return result({linked:false},200,origin)
 if(req.method==='POST'){
  try{
   const body=await req.json()
   const value=String(body.starts_at||'')
   if(!/^\d{4}-\d{2}-\d{2}T(1[3-9]|2[01]):00:00\+03:00$/.test(value))return result({error:'Choose an hourly slot from 1 PM to 9 PM Riyadh time.'},400,origin)
   const starts=new Date(value)
   if(!Number.isFinite(starts.getTime())||starts.getTime()<Date.now()+48*3600000)return result({error:'Choose a date at least 48 hours ahead.'},400,origin)
   const {data:existing}=await db.from('maktoub_intake_bookings').select('id').eq('person_id',person.id).in('status',['awaiting_payment','pending','accepted','rescheduled']).limit(1)
   if(existing?.length)return result({error:'You already have an active intake request.'},409,origin)
   const {data:booking,error:insertError}=await db.from('maktoub_intake_bookings').insert({
    person_id:person.id,starts_at:starts.toISOString(),booking_email:data.user.email,
    status:'pending',payment_status:'unpaid',timezone:'Asia/Riyadh'
   }).select('id,starts_at,status').single()
   if(insertError){console.error('Intake request failed',insertError);return result({error:'That slot may be unavailable. Please select another.'},409,origin)}
   const bot=Deno.env.get('MAKTOUB_TELEGRAM_BOT_TOKEN'),chat=Deno.env.get('MAKTOUB_TELEGRAM_CHAT_ID')
   if(bot&&chat){try{const response=await fetch('https://api.telegram.org/bot'+bot+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chat,text:'New Maktoub intake request\\n'+person.full_name+'\\n'+starts.toLocaleString('en-GB',{timeZone:'Asia/Riyadh'})+' Riyadh\\nStatus: pending approval and payment'}),signal:AbortSignal.timeout(3000)});if(!response.ok)console.error('Telegram booking alert failed',response.status)}catch(e){console.error('Telegram booking alert failed',e)}}
   return result({success:true,booking},200,origin)
  }catch(e){console.error('Intake request error',e);return result({error:'Unable to request intake.'},500,origin)}
 }

 const [{data:bookings,error:bErr},{data:events,error:eErr}]=await Promise.all([
  db.from('maktoub_intake_bookings').select('id,starts_at,status,payment_status').eq('person_id',person.id).order('created_at',{ascending:false}).limit(10),
  db.from('maktoub_event_contacts').select('event_id,status').eq('person_id',person.id)
 ])
 if(bErr||eErr)return result({error:'Unable to load account'},500,origin)
 return result({linked:true,person:{full_name:person.full_name,stage:person.stage,intake_status:person.intake_status,interest_matchmaking:person.interest_matchmaking,interest_social:person.interest_social,interest_events:person.interest_events},bookings,events},200,origin)
})