const test=require("node:test"),assert=require("node:assert/strict");
const {createNicknameAI,SALES_MATCH}=require("../nickname-protection/ai");
test("AI validates configured term, high confidence, cache and rules changes",async()=>{
  let calls=0,result={term:"proibido",confidence:0.99};
  const ai=createNicknameAI({env:{NICKNAME_AI_PROVIDER:"gemini",GEMINI_API_KEY:"mock"},fetchImpl:async(_url,options)=>{
    assert.match(_url,/gemini-3\.5-flash-lite:generateContent/);
    assert.equal(JSON.parse(options.body).generationConfig.thinkingConfig.thinkingLevel,"low");
    const schema=JSON.parse(options.body).generationConfig.responseJsonSchema;
    assert.deepEqual(schema.required,["term","confidence"]);
    const sentTerms=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).terms;
    assert.deepEqual(schema.properties.term.enum,[...sentTerms,null]);
    calls++;assert.match(options.body,/não confiável/);
    return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(result)}]}}]})};
  }});
  assert.equal(await ai.detect("pr0ibido",["proibido"]),"proibido");
  assert.equal(await ai.detect("pr0ibido",["proibido"]),"proibido");assert.equal(calls,1);
  result={term:"outro",confidence:0.8};assert.equal(await ai.detect("0utro",["outro"]),null);
  result={term:"inventado",confidence:1};await assert.rejects(ai.detect("novo",["proibido"]));
});
test("Gemini reasoning parts are ignored and a whole JSON code block is accepted",async()=>{
  const ai=createNicknameAI({env:{NICKNAME_AI_PROVIDER:"gemini",GEMINI_API_KEY:"mock"},fetchImpl:async()=>({ok:true,json:async()=>({
    candidates:[{finishReason:"STOP",content:{parts:[
      {thought:true,text:'{"term":"proibido","confidence":1}'},
      {text:'```json\n{"term":null,"confidence":0}\n```'}
    ]}}]
  })})});
  assert.equal(await ai.detect("nickname",["proibido"]),null);
});
for(const [body,kind] of [
  [{candidates:[{finishReason:"MAX_TOKENS",content:{parts:[{text:'{"term":"proibido","confidence":1}'}]}}]},"ai_truncated"],
  [{candidates:[{finishReason:"SAFETY"}]},"ai_filtered"],
  [{promptFeedback:{blockReason:"SAFETY"}},"ai_filtered"],
  [{candidates:[{finishReason:"STOP",content:{parts:[{thought:true,text:"reasoning"}]}}]},"ai_empty"],
  [{candidates:[{finishReason:"STOP",content:{parts:[{text:'{"term":"inventado","confidence":1}'}]}}]},"ai_invalid_response"]
]){
  test(`Gemini ${kind} responses never produce a violation`,async()=>{
    const ai=createNicknameAI({env:{NICKNAME_AI_PROVIDER:"gemini",GEMINI_API_KEY:"mock"},fetchImpl:async()=>({ok:true,json:async()=>body})});
    await assert.rejects(ai.detect("nickname",["proibido"]),error=>error.kind===kind);
  });
}
test("no key means no AI network, provider failures never approve a match",async()=>{
  const ai=createNicknameAI({env:{},fetchImpl:()=>assert.fail("No network")});
  assert.equal(await ai.detect("teste",["teste"]),null);
  const failing=createNicknameAI({env:{NICKNAME_AI_PROVIDER:"gemini",GEMINI_API_KEY:"mock"},fetchImpl:async()=>({ok:false,status:429})});
  await assert.rejects(failing.detect("pr0ibido",["proibido"]));
});
test("quota errors report safe diagnostics and pause new API calls",async()=>{
  let calls=0,clock=100000;
  const ai=createNicknameAI({env:{NICKNAME_AI_PROVIDER:"gemini",GEMINI_API_KEY:"secret-not-for-logs"},now:()=>clock,fetchImpl:async()=>{calls++;return {ok:false,status:429};}});
  await assert.rejects(ai.detect("pr0ibido",["proibido"]),e=>e.kind==="ai_rate_limit"&&e.status===429&&!e.message.includes("secret"));
  await assert.rejects(ai.detect("p.r.o.i.b.i.d.o",["proibido"]),e=>e.kind==="ai_rate_limit");
  assert.equal(calls,1);
  clock+=60001;
  await assert.rejects(ai.detect("pr0ibido",["proibido"]));
  assert.equal(calls,2);
});
test("Gemini overload is diagnosed as temporary and pauses calls for one minute",async()=>{
  let calls=0,clock=100000;
  const ai=createNicknameAI({env:{NICKNAME_AI_PROVIDER:"gemini",GEMINI_API_KEY:"mock"},now:()=>clock,fetchImpl:async()=>{
    calls++;return {ok:false,status:503};
  }});
  await assert.rejects(ai.detect("apelido",["termo"]),e=>e.kind==="ai_unavailable"&&e.status===503);
  await assert.rejects(ai.detect("outro",["termo"]),e=>e.kind==="ai_unavailable");
  assert.equal(calls,1);
  clock+=60001;
  await assert.rejects(ai.detect("outro",["termo"]),e=>e.kind==="ai_unavailable"&&e.status===503);
  assert.equal(calls,2);
});
test("GPT-OSS uses Groq only, strict JSON output, low reasoning and caches validated results",async()=>{
  let calls=0;
  const ai=createNicknameAI({env:{GROQ_API_KEY:"groq-mock",GEMINI_API_KEY:"unused",OPENAI_API_KEY:"unused"},fetchImpl:async(url,options)=>{
    calls++;
    assert.equal(String(url),"https://api.groq.com/openai/v1/chat/completions");
    assert.equal(new Headers(options.headers).get("authorization"),"Bearer groq-mock");
    const body=JSON.parse(options.body);
    assert.equal(body.model,"openai/gpt-oss-20b");
    assert.equal(body.reasoning_effort,"low");
    assert.equal(body.max_completion_tokens,2048);
    assert.equal(body.response_format.json_schema.strict,true);
    assert.deepEqual(body.response_format.json_schema.schema.properties.term.enum,["proibido",null]);
    return Response.json({choices:[{finish_reason:"stop",message:{content:'{"term":"proibido","confidence":0.99}'}}]});
  }});
  assert.equal(ai.provider,"groq");
  assert.equal(ai.model,"openai/gpt-oss-20b");
  assert.equal(await ai.detect("pr0ibido",["proibido"]),"proibido");
  assert.equal(await ai.detect("pr0ibido",["proibido"]),"proibido");
  assert.equal(calls,1);
});
test("a dedicated nickname token overrides the shared Bedrock token without changing the provider",async()=>{
  const ai=createNicknameAI({env:{
    NICKNAME_AI_PROVIDER:"bedrock",NICKNAME_AI_MODEL:"openai.gpt-oss-20b",AWS_REGION:"us-east-2",
    AWS_BEARER_TOKEN_BEDROCK:"shared-token",NICKNAME_AI_API_KEY:"nickname-token"
  },fetchImpl:async(_url,options)=>{
    assert.equal(new Headers(options.headers).get("authorization"),"Bearer nickname-token");
    return Response.json({choices:[{finish_reason:"stop",message:{content:'{"term":null,"confidence":0}'}}]});
  }});
  assert.equal(await ai.detect("nome",["termo"]),null);
});
test("without a Groq key the default never silently uses Gemini or OpenAI",async()=>{
  const ai=createNicknameAI({env:{GEMINI_API_KEY:"unused",OPENAI_API_KEY:"unused"},fetchImpl:()=>assert.fail("No fallback allowed")});
  assert.equal(ai.configured,false);
  assert.equal(await ai.detect("pr0ibido",["proibido"]),null);
});
for(const [choice,kind] of [
  [{finish_reason:"length",message:{content:'{"term":"proibido","confidence":1}'}},"ai_truncated"],
  [{finish_reason:"stop",message:{refusal:"No",content:null}},"ai_filtered"],
  [{finish_reason:"stop",message:{content:null}},"ai_empty"],
  [{finish_reason:"stop",message:{content:'{"term":"inventado","confidence":1}'}},"ai_invalid_response"],
  [{finish_reason:"stop",message:{content:'{"term":"proibido","confidence":"0.99"}'}},"ai_invalid_response"]
]){
  test(`GPT-OSS ${kind} does not approve an invalid result`,async()=>{
    const ai=createNicknameAI({env:{GROQ_API_KEY:"mock"},fetchImpl:async()=>Response.json({choices:[choice]})});
    await assert.rejects(ai.detect("nickname",["proibido"]),error=>error.kind===kind&&error.provider==="groq");
  });
}
test("Groq rate limits pause calls and never expose the provider response or credentials",async()=>{
  let calls=0;
  const ai=createNicknameAI({env:{GROQ_API_KEY:"secret"},fetchImpl:async()=>{
    calls++;return Response.json({error:{message:"secret nickname and credential"}},{status:429});
  }});
  await assert.rejects(ai.detect("nickname",["proibido"]),e=>e.kind==="ai_rate_limit"&&e.status===429&&e.provider==="groq"&&!e.message.includes("secret"));
  await assert.rejects(ai.detect("different",["proibido"]),e=>e.kind==="ai_rate_limit");
  assert.equal(calls,1);
});
test("sales mode uses an independent structured classification even without custom terms",async()=>{
  let calls=0;
  const ai=createNicknameAI({env:{GROQ_API_KEY:"mock"},fetchImpl:async(_url,options)=>{
    calls++;
    const body=JSON.parse(options.body),schema=body.response_format.json_schema.schema;
    assert.equal(schema.properties.sales.type,"boolean");
    assert.ok(schema.required.includes("salesConfidence"));
    assert.match(body.messages[0].content,/nitrada na bio/);
    assert.match(body.messages[0].content,/nitrada barata na bio/);
    assert.match(body.messages[0].content,/NÃO tem acesso ao perfil/);
    assert.match(body.messages[0].content,/estudante de biologia/);
    return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({
      term:null,confidence:0,sales:true,salesConfidence:0.99
    })}}]});
  }});
  assert.equal(await ai.detect("nitrada na bio",[],{sales:true}),SALES_MATCH);
  assert.equal(await ai.detect("nitrada barata na bio",[],{sales:true}),SALES_MATCH);
  assert.equal(await ai.detect("nitrada na bio",[],{sales:false}),null);
  assert.equal(calls,2);
});
test("sales cache is separated from the normal term rules",async()=>{
  let calls=0;
  const ai=createNicknameAI({env:{GROQ_API_KEY:"mock"},fetchImpl:async(_url,options)=>{
    calls++;
    const sales=JSON.parse(options.body).response_format.json_schema.schema.required.includes("sales");
    return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({
      term:null,confidence:0,...(sales?{sales:true,salesConfidence:0.99}:{})
    })}}]});
  }});
  assert.equal(await ai.detect("nitrada na bio",["outro"]),null);
  assert.equal(await ai.detect("nitrada na bio",["outro"],{sales:true}),SALES_MATCH);
  assert.equal(await ai.detect("nitrada na bio",["outro"],{sales:false}),null);
  assert.equal(calls,2);
});
for(const salesResult of [
  {sales:false,salesConfidence:1},
  {sales:true,salesConfidence:0.8}
]){
  test(`sales classification does not punish negative or uncertain results (${JSON.stringify(salesResult)})`,async()=>{
    const ai=createNicknameAI({env:{GROQ_API_KEY:"mock"},fetchImpl:async()=>Response.json({
      choices:[{finish_reason:"stop",message:{content:JSON.stringify({term:null,confidence:0,...salesResult})}}]
    })});
    assert.equal(await ai.detect("estudante de biologia",[],{sales:true}),null);
  });
}
test("malformed sales confidence is rejected instead of converted to a violation",async()=>{
  const ai=createNicknameAI({env:{GROQ_API_KEY:"mock"},fetchImpl:async()=>Response.json({
    choices:[{finish_reason:"stop",message:{content:'{"term":null,"confidence":0,"sales":true,"salesConfidence":"1"}'}}]
  })});
  await assert.rejects(ai.detect("nitrada na bio",[],{sales:true}),error=>error.kind==="ai_invalid_response");
});
for(const status of [400,401,403,404,503]){
  test(`GPT-OSS HTTP ${status} does not switch to another model`,async()=>{
    let calls=0;
    const ai=createNicknameAI({env:{GROQ_API_KEY:"mock"},fetchImpl:async(_url,options)=>{
      assert.equal(JSON.parse(options.body).model,"openai/gpt-oss-20b");
      calls++;return Response.json({error:{message:"request failed"}},{status});
    }});
    await assert.rejects(ai.detect("nickname",["proibido"]));
    assert.equal(calls,1);
  });
}
test("GPT-OSS 429 waits and later retries the same model without a fallback",async()=>{
  const models=[];let clock=100000;
  const ai=createNicknameAI({env:{GROQ_API_KEY:"mock"},now:()=>clock,fetchImpl:async(_url,options)=>{
    models.push(JSON.parse(options.body).model);
    return Response.json({error:{message:"rate limit"}},{status:429});
  }});
  await assert.rejects(ai.detect("nickname",["proibido"]),error=>error.kind==="ai_rate_limit");
  await assert.rejects(ai.detect("other",["proibido"]),error=>error.kind==="ai_rate_limit");
  assert.equal(models.length,1);
  clock+=60001;
  await assert.rejects(ai.detect("other",["proibido"]),error=>error.kind==="ai_rate_limit");
  assert.deepEqual(models,["openai/gpt-oss-20b","openai/gpt-oss-20b"]);
});
test("Safeguard falls back to 20B on 429, then uses the reserve during Retry-After",async()=>{
  const calls=[];let clock=100000;
  const ai=createNicknameAI({env:{GROQ_API_KEY:"mock",NICKNAME_AI_MODEL:"openai/gpt-oss-safeguard-20b"},now:()=>clock,fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    if(body.model==="openai/gpt-oss-safeguard-20b"){
      assert.equal(body.response_format.json_schema.strict,false);
      return Response.json({error:{message:"rate limit"}},{status:429,headers:{"retry-after":"120"}});
    }
    assert.equal(body.model,"openai/gpt-oss-20b");
    assert.equal(body.response_format.json_schema.strict,true);
    return Response.json({choices:[{finish_reason:"stop",message:{content:'{"term":null,"confidence":0,"sales":true,"salesConfidence":0.99}'}}]});
  }});
  assert.equal(await ai.detect("nitrada na bio",[],{sales:true}),SALES_MATCH);
  assert.deepEqual(calls.map(c=>c.model),["openai/gpt-oss-safeguard-20b","openai/gpt-oss-20b"]);
  assert.deepEqual(calls[0].messages,calls[1].messages);
  assert.deepEqual(calls[0].response_format.json_schema.schema,calls[1].response_format.json_schema.schema);
  clock+=61000;
  await ai.detect("nitrada barata na bio",[],{sales:true});
  assert.equal(calls.length,3);
  assert.equal(calls.at(-1).model,"openai/gpt-oss-20b");
  clock+=60000;
  await ai.detect("nitro no perfil",[],{sales:true});
  assert.equal(calls.at(-2).model,"openai/gpt-oss-safeguard-20b");
});
test("both models returning 429 cause a pause without repeated requests or a presumed violation",async()=>{
  let calls=0;
  const ai=createNicknameAI({env:{GROQ_API_KEY:"mock",NICKNAME_AI_MODEL:"openai/gpt-oss-safeguard-20b"},fetchImpl:async()=>{
    calls++;return Response.json({error:{message:"rate limit"}},{status:429});
  }});
  await assert.rejects(ai.detect("nickname",["proibido"]),error=>error.kind==="ai_rate_limit");
  await assert.rejects(ai.detect("other",["proibido"]),error=>error.kind==="ai_rate_limit");
  assert.equal(calls,2);
});
test("Safeguard fallback cannot exceed the local daily request quota",async()=>{
  let calls=0;
  const ai=createNicknameAI({env:{GROQ_API_KEY:"mock",NICKNAME_AI_MODEL:"openai/gpt-oss-safeguard-20b",NICKNAME_AI_DAILY_REQUESTS:"1"},fetchImpl:async()=>{
    calls++;return Response.json({error:{message:"rate limit"}},{status:429});
  }});
  await assert.rejects(ai.detect("nickname",["proibido"]),error=>error.kind==="ai_daily_limit");
  assert.equal(calls,1);
});
test("Safeguard errors other than 429 do not trigger a fallback",async()=>{
  let calls=0;
  const ai=createNicknameAI({env:{GROQ_API_KEY:"mock",NICKNAME_AI_MODEL:"openai/gpt-oss-safeguard-20b"},fetchImpl:async()=>{
    calls++;return Response.json({error:{message:"unavailable"}},{status:503});
  }});
  await assert.rejects(ai.detect("nickname",["proibido"]),error=>error.kind==="ai_unavailable");
  assert.equal(calls,1);
});
test("Bedrock uses its regional Mantle endpoint and API key without Groq or OpenAI credentials",async()=>{
  const ai=createNicknameAI({env:{
    NICKNAME_AI_PROVIDER:"bedrock",NICKNAME_AI_MODEL:"openai.gpt-oss-safeguard-20b",AWS_REGION:"us-east-1",AWS_BEARER_TOKEN_BEDROCK:"bedrock-mock",
    GROQ_API_KEY:"must-not-use",OPENAI_API_KEY:"must-not-use",OPENAI_BASE_URL:"https://wrong.invalid/v1"
  },fetchImpl:async(url,options)=>{
    assert.equal(String(url),"https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions");
    assert.equal(new Headers(options.headers).get("authorization"),"Bearer bedrock-mock");
    const body=JSON.parse(options.body);
    assert.equal(body.model,"openai.gpt-oss-safeguard-20b");
    assert.equal(body.messages[0].role,"developer");
    assert.equal(body.max_completion_tokens,512);
    assert.equal(body.reasoning_effort,"low");
    assert.equal(body.response_format,undefined,"Bedrock Mantle usa JSON validado localmente");
    assert.match(body.messages[0].content,/"confidence"/);
    assert.match(body.messages[0].content,/"salesConfidence"/);
    return Response.json({choices:[{finish_reason:"stop",message:{content:'{"term":null,"confidence":0,"sales":true,"salesConfidence":0.99}'}}]});
  }});
  assert.equal(ai.provider,"bedrock");
  assert.equal(ai.configured,true);
  assert.equal(await ai.detect("nitrada na bio",[],{sales:true}),SALES_MATCH);
});
test("Bedrock Safeguard 429 falls back to the Bedrock Mantle GPT-OSS model, not to Groq",async()=>{
  const models=[];let clock=100000;
  const ai=createNicknameAI({env:{
    NICKNAME_AI_PROVIDER:"bedrock",NICKNAME_AI_MODEL:"openai.gpt-oss-safeguard-20b",AWS_REGION:"us-east-1",AWS_BEARER_TOKEN_BEDROCK:"mock"
  },now:()=>clock,fetchImpl:async(url,options)=>{
    assert.match(String(url),/^https:\/\/bedrock-mantle\.us-east-1\.api\.aws\//);
    const {model}=JSON.parse(options.body);models.push(model);
    if(model==="openai.gpt-oss-safeguard-20b")return Response.json({message:"Throttled"},{status:429,headers:{"retry-after":"120"}});
    return Response.json({choices:[{finish_reason:"stop",message:{content:'{"term":"proibido","confidence":0.99}'}}]});
  }});
  assert.equal(await ai.detect("pr0ibido",["proibido"]),"proibido");
  clock+=61000;
  await ai.detect("pr0ibid0",["proibido"]);
  assert.deepEqual(models,["openai.gpt-oss-safeguard-20b","openai.gpt-oss-20b","openai.gpt-oss-20b"]);
});
for(const extra of [
  {AWS_REGION:"us-east-1"},
  {AWS_BEARER_TOKEN_BEDROCK:"mock"},
  {AWS_REGION:"invalid.example.com/path",AWS_BEARER_TOKEN_BEDROCK:"mock"}
]){
  test("Bedrock incomplete configuration cannot silently use another provider's key",async()=>{
    const ai=createNicknameAI({env:{NICKNAME_AI_PROVIDER:"bedrock",GROQ_API_KEY:"must-not-use",OPENAI_API_KEY:"must-not-use",...extra},
      fetchImpl:()=>assert.fail("No network allowed")});
    assert.equal(ai.configured,false);
    assert.equal(await ai.detect("pr0ibido",["proibido"]),null);
  });
}
test("Bedrock numeric confidence is still range-checked locally without schema numeric constraints",async()=>{
  const ai=createNicknameAI({env:{NICKNAME_AI_PROVIDER:"bedrock",AWS_REGION:"us-east-1",AWS_BEARER_TOKEN_BEDROCK:"mock"},
    fetchImpl:async()=>Response.json({choices:[{finish_reason:"stop",message:{content:'{"term":"proibido","confidence":2}'}}]})});
  await assert.rejects(ai.detect("pr0ibido",["proibido"]),error=>error.kind==="ai_invalid_response"&&error.provider==="bedrock");
});
test("Bedrock access errors are sanitized and never trigger a provider fallback",async()=>{
  let calls=0;
  const ai=createNicknameAI({env:{NICKNAME_AI_PROVIDER:"bedrock",AWS_REGION:"us-east-1",AWS_BEARER_TOKEN_BEDROCK:"secret-key"},
    fetchImpl:async()=>{
      calls++;return Response.json({message:"secret-key denied"},{status:403});
    }});
  await assert.rejects(ai.detect("nickname",["proibido"]),error=>error.kind==="ai_credentials"&&error.status===403&&!error.message.includes("secret-key"));
  assert.equal(calls,1);
});
