const {setTimeout:delay}=require('node:timers/promises');
const hasMarker=bio=>/(^|[^a-z0-9_])\/mds(?![a-z0-9_])/i.test(bio);
function createProfileClient({token=process.env.DISCORD_BIO_CHECK_USER_TOKEN||'',fetchImpl=(...args)=>fetch(...args),now=()=>Date.now(),wait=delay}={}){
  token=token.trim();const enabled=Boolean(token);let tail=Promise.resolve(),queued=0,lastStart=-Infinity,pauseUntil=0,pauseReason='rate_limited';
  const pending=new Map(),visualCache=new Map();
  const unknown=(reason,retryAt=now()+300000)=>({status:'unknown',reason,retryAt});
  function visualBadges(data){
    if(!Array.isArray(data.badges)||data.badges.length>64)return unknown('invalid_response');
    const badges=[],seen=new Set();
    for(const badge of data.badges){
      if(!badge||!/^[-a-z0-9_]{1,100}$/i.test(badge.id)||!/^[a-f0-9]{32,64}$/i.test(badge.icon)||typeof badge.description!=='string')continue;
      if(seen.has(badge.id))continue;seen.add(badge.id);
      const description=badge.description.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,320);
      if(!description)continue;
      badges.push({id:`native:${badge.id}`,kind:'discord',label:description.slice(0,160),description,
        icon:`https://cdn.discordapp.com/badge-icons/${badge.icon}.png`});
    }
    if(data.badges.length&&!badges.length)return unknown('invalid_response');
    return {status:'available',badges,checkedAt:now()};
  }
  async function request(gid,uid){
    if(!/^\d{17,20}$/.test(gid)||!/^\d{17,20}$/.test(uid))return unknown('invalid_id');
    if(/[\r\n]/.test(token)||token.startsWith('Bot '))return unknown('invalid_credentials');
    if(now()<pauseUntil)return unknown(pauseReason,pauseUntil);
    const waitMs=Math.max(0,lastStart+2000-now());if(waitMs)await wait(waitMs);
    if(now()<pauseUntil)return unknown(pauseReason,pauseUntil);lastStart=now();
    try{
      const response=await fetchImpl(`https://discord.com/api/v9/users/${uid}/profile?guild_id=${gid}`,{method:'GET',headers:{Authorization:token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});
      let data;try{data=await response.json();}catch{return unknown('invalid_response');}
      if(response.status===429){pauseReason='rate_limited';pauseUntil=now()+Math.max(1000,(Number(data?.retry_after)||Number(response.headers?.get('retry-after'))||60)*1000);return unknown('rate_limited',pauseUntil);}
      if(response.status===401){pauseReason='invalid_credentials';pauseUntil=now()+300000;return unknown('invalid_credentials',pauseUntil);}
      if(response.status===403||response.status===404)return unknown('inaccessible_or_private');
      if(!response.ok)return unknown('provider_error');
      if(data?.user?.id!==uid)return unknown('invalid_response');
      if(Object.hasOwn(data,'user_profile')&&data.user_profile===null)return unknown('inaccessible_or_private');
      const bio=typeof data.user_profile?.bio==='string'?data.user_profile.bio:typeof data.user.bio==='string'?data.user.bio:null;
       // Only projections leave this function. Never return/store the raw profile,
       // bio, mutual friends, guild list or credential.
       const eligibility=bio===null?unknown('inaccessible_or_private'):{status:hasMarker(bio)?'present':'missing',reason:null,retryAt:null};
       return {eligibility,visuals:visualBadges(data)};
    }catch{return unknown('connection_error');}
  }
  function enqueue(gid,uid,{deadline=Infinity}={}){
    if(!enabled)return Promise.resolve({status:'disabled'});
    const key=`${gid}:${uid}`;if(pending.has(key))return pending.get(key);
    if(queued>=25)return Promise.resolve(unknown('queue_full',now()+60000));
    queued++;const task=tail.then(()=>now()>deadline?unknown('queue_expired',now()+60000):request(gid,uid)).then(result=>{
      if(result.visuals?.status==='available'){
        if(visualCache.size>=256)visualCache.delete(visualCache.keys().next().value);
        visualCache.set(key,{expiresAt:now()+300000,result:result.visuals});
      }
      return result;
    }).finally(()=>{queued--;pending.delete(key);});
    tail=task.catch(()=>{});pending.set(key,task);return task;
  }
  const check=(gid,uid)=>enqueue(gid,uid).then(result=>result.eligibility||result);
  function visuals(gid,uid){
    if(!enabled)return Promise.resolve({status:'disabled'});
    const key=`${gid}:${uid}`,cached=visualCache.get(key);
    if(cached&&cached.expiresAt>now())return Promise.resolve(cached.result);
    return enqueue(gid,uid,{deadline:now()+10000}).then(result=>{
      const value=result.visuals||result;
      // Failures are cached briefly so the profile page cannot hammer the
      // shared secondary account or retry a private profile on every open.
      if(value.status!=='available'){
        if(visualCache.size>=256)visualCache.delete(visualCache.keys().next().value);
        visualCache.set(key,{expiresAt:now()+60000,result:value});
      }
      return value;
    });
  }
  return {enabled,check,visuals};
}
let shared;
function getSharedProfileClient({token=process.env.DISCORD_BIO_CHECK_USER_TOKEN||''}={}){
  token=token.trim();
  if(!shared||shared.token!==token)shared={token,client:createProfileClient({token})};
  return shared.client;
}
module.exports={createProfileClient,getSharedProfileClient,hasMarker};
