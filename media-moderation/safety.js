// Textual routing signals, not evidence of a confirmed violation or age detection.
function childSafetySignal(value){
  const text=String(value||"").normalize("NFKC");
  if(/\b(?:csam|cp|abuso sexual infantil|pornografia infantil|menor nu|nudez infantil|child sexual abuse|child pornography)\b/i.test(text))return true;
  const minor="(?:crianças?|criancas?|menores?|infantil|children|child|underage)";
  const sexual="(?:\\+\\s*18|18\\s*\\+|pornografi[a-z]*|porn[a-z]*|sexua[a-z]*|sexual[a-z]*|nudez|nudes?|naked|exploraç[aã]o sexual|exploracao sexual)";
  return new RegExp(`${minor}[\\s\\S]{0,80}${sexual}|${sexual}[\\s\\S]{0,80}${minor}`,"i").test(text);
}
module.exports={childSafetySignal};
