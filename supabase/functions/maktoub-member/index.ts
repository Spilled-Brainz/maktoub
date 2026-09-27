import { createClient } from 'npm:@supabase/supabase-js@2'
const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{autoRefreshToken:false,persistSession:false}})
const origins=new Set(['https://maktoub.app','https://www.maktoub.app'])
const headers=(origin:string|null)=>({'Content-Type':'application/json','Vary':'Origin',...(origin&&origins.has(origin)?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'authorization'}:{})})
const result=(data:unknown,status:number,origin:string|null)=>new Response(JSON.stringify(data),{status,headers:headers(origin)})
Deno.serve(async(req)=>{
 const origin=req.headers.get('origin')
 if(origin&&!origins.has(origin))return result({error:'Forbidden'},403,origin)
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:headers(origin)})
 if(req.method!=='GET')return result({error:'Method'},405,origin)
 const token=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'')
 if(!token)return result({error:'Sign in required'},401,origin)
 const {data,error}=await db.auth.getUser(token)
 if(error||!data.user?.email||!data.user.email_confirmed_at)return result({error:'Verified email required'},401,origin)
 const {data:person,error:personError}=await db.from('maktoub_people').select('id,full_name,email,stage,intake_status,interest_matchmaking,interest_social,interest_events').ilike('email',data.user.email).maybeSingle()
 if(personError)return result({error:'Unable to load account'},500,origin)
 if(!person)return result({linked:false},200,origin)
 const [{data:bookings,error:bErr},{data:events,error:eErr}]=await Promise.all([
  db.from('maktoub_intake_bookings').select('id,starts_at,status,payment_status').eq('person_id',person.id).order('created_at',{ascending:false}).limit(10),
  db.from('maktoub_event_contacts').select('event_id,status').eq('person_id',person.id)
 ])
 if(bErr||eErr)return result({error:'Unable to load account'},500,origin)
 return result({linked:true,person:{full_name:person.full_name,stage:person.stage,intake_status:person.intake_status,interest_matchmaking:person.interest_matchmaking,interest_social:person.interest_social,interest_events:person.interest_events},bookings,events},200,origin)
})