const test=require("node:test");
const assert=require("node:assert/strict");
const {childSafetySignal}=require("../media-moderation/safety");
const {interpret}=require("../media-moderation/openai");
const {createProcessor}=require("../media-moderation/processor");
test("ordinary children are not a textual abuse signal; sexualization signals route before any API",async()=>{
  for(const text of ["crianças brincando no parque","festa infantil","children at school"])assert.equal(childSafetySignal(text),false);
  for(const text of ["conteúdo +18 envolvendo menores","crianças e material 18+","CSAM"])assert.equal(childSafetySignal(text),true);
  let calls=0;const p=createProcessor({moderation:{configured:true,classify:async()=>{calls++;}}});
  await assert.rejects(p.moderate(Buffer.from("not submitted"),"image/png",{rules:{}},"conteúdo +18 envolvendo menores"),e=>e.kind==="child_safety");assert.equal(calls,0);
});
test("safety rules alone do not send clean images to review",()=>{
  const clean={modality:"image",categories:{sexual:false},category_scores:{sexual:0},category_applied_input_types:{sexual:["image"]}};
  for(const rule of ["childProtection","nazism","extremism"])assert.equal(interpret([clean],{[rule]:true}).decision,"approved");
});
test("official hate and illicit violence signals enforce related rules, while child safety never becomes routine approval",()=>{
  for(const [rule,key] of [["nazism","hate"],["extremism","illicit/violent"]]){
    const r={modality:"text",categories:{[key]:true},category_scores:{[key]:0.99},category_applied_input_types:{[key]:["text"]}};
    assert.equal(interpret([r],{[rule]:true}).decision,"blocked");
    assert.equal(interpret([r],{[rule]:false}).decision,"approved");
  }
  const minor={modality:"text",categories:{"sexual/minors":true},category_scores:{"sexual/minors":0.99},category_applied_input_types:{"sexual/minors":["text"]}};
  assert.equal(interpret([minor],{protectServer:false,childProtection:false}).decision,"review");
});
