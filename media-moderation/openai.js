const OpenAI=require("openai");
const {setTimeout:delay}=require("node:timers/promises");
const DEFAULT_MODEL="omni-moderation-latest";
const IMAGE_CATEGORIES=["sexual","violence","violence/graphic","self-harm","self-harm/intent","self-harm/instructions"];
function createModeration({apiKey=process.env.OPENAI_API_KEY,client,sleep=delay,random=Math.random}={}){
  const model=process.env.OPENAI_MODERATION_MODEL?.trim()||DEFAULT_MODEL;
  const timeout=Math.max(1000,Math.min(60000,Number(process.env.MEDIA_MODERATION_API_TIMEOUT_MS)||20000));
  const retries=Math.max(0,Math.min(4,Number(process.env.MEDIA_MODERATION_API_RETRIES)||2));
  const sdk=client||(apiKey?.trim()?new OpenAI({apiKey:apiKey.trim(),timeout,maxRetries:0}):null);
  async function request(operation,onRequest=()=>{}){
    if(!sdk)throw Object.assign(new Error("OPENAI_API_KEY não configurada"),{kind:"configuration"});
    for(let attempt=0;;attempt++)try{onRequest();return await operation(sdk);}catch(error){
      const status=error.status;
      const transient=status===429||status===408||status>=500||["APIConnectionError","APIConnectionTimeoutError"].includes(error.name);
      if(!transient||attempt>=retries)throw Object.assign(new Error(`OpenAI: ${transient?"falha transitória persistente":status?`erro permanente HTTP ${status}`:"resposta ou configuração inválida"}; análise não concluída`),{kind:transient?"transient":error.kind||"permanent"});
      const retryAfter=Number(error.headers?.get?.("retry-after"));
      if(retryAfter>60)throw new Error("OpenAI: rate limit prolongado; revisão necessária");
      await sleep(Math.min(60000,Math.max(Number.isFinite(retryAfter)?retryAfter*1000:0,500*2**attempt+random()*500)));
    }
  }
  return {configured:Boolean(sdk),model,async classify(input,modality,onRequest){
    const response=await request(c=>c.moderations.create({model,input}),onRequest);
    const r=response.results?.[0];
    if(response.results?.length!==1||!r||typeof r.flagged!=="boolean"||!r.categories||!r.category_scores||!r.category_applied_input_types)throw new Error("Resposta de moderação OpenAI inválida");
    const keys=modality==="image"?IMAGE_CATEGORIES:Object.keys(r.categories);
    if(!keys.length||keys.some(key=>typeof r.categories[key]!=="boolean"||!Number.isFinite(r.category_scores[key])||r.category_scores[key]<0||r.category_scores[key]>1||!Array.isArray(r.category_applied_input_types[key])||!r.category_applied_input_types[key].includes(modality)))throw new Error("Resposta OpenAI incompleta para a modalidade analisada");
    return {id:response.id,model:response.model,...r,modality};
  },async transcribe(file,onRequest){
    const result=await request(c=>c.audio.transcriptions.create({file,model:process.env.MEDIA_MODERATION_TRANSCRIPTION_MODEL||"gpt-4o-mini-transcribe"}),onRequest);
    if(typeof result.text!=="string")throw new Error("Transcrição OpenAI inválida");
    return result.text;
  }};
}
function interpret(results,rules,{complete=true}={}){
  const enabled={sexual:rules.sexual,"violence/graphic":rules.graphicViolence,violence:rules.violence,
    "self-harm":rules.selfHarm,"self-harm/intent":rules.selfHarm,"self-harm/instructions":rules.selfHarm,
    hate:rules.hate||rules.nazism||rules.extremism,"hate/threatening":rules.hate||rules.nazism||rules.extremism,harassment:rules.targetedHarassment,"harassment/threatening":rules.targetedHarassment,
    illicit:rules.illicit,"illicit/violent":rules.illicit||rules.extremism};
  const categories=[...new Set(results.flatMap(r=>Object.keys(r.categories).filter(k=>r.categories[k]&&r.category_applied_input_types[k]?.includes(r.modality))))];
  const active=k=>rules.protectServer===true||enabled[k]||(k==="violence"&&rules.allowGameWeapons===false);
  // Official category booleans already encode the provider's classification.
  // Scores are not calibrated probabilities: a second 0.9 threshold was routing
  // valid classifications to humans instead of accepting the API decision.
  const blocked=categories.some(k=>active(k));
  const inconsistent=results.some(r=>r.flagged===true&&!Object.keys(r.categories).some(k=>r.categories[k]&&r.category_applied_input_types[k]?.includes(r.modality)));
  const review=!results.length||!complete||inconsistent||categories.includes("sexual/minors");
  const decision=categories.includes("sexual/minors")?"review":blocked?"blocked":review?"review":"approved";
  return {decision,categories,confidence:null,requiresHumanReview:decision==="review",reason:decision==="blocked"?"Violação de categoria configurada classificada pela OpenAI.":decision==="review"?(categories.includes("sexual/minors")?"Sinalização de segurança infantil; procedimento especializado.":!complete?"Análise incompleta da mídia; revisão necessária.":"Resposta ausente ou inconclusiva para a modalidade; revisão necessária."):"Análise concluída sem acionar as regras configuradas.",rawResults:results};
}
module.exports={createModeration,interpret,DEFAULT_MODEL,IMAGE_CATEGORIES};
