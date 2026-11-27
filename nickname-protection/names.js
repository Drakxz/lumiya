function memberNames(member) {
  const value=member?.nickname;
  if(typeof value!=="string"||!value.trim())return [];
  return [{field:"nickname",label:"apelido do servidor",value}];
}
// Never fall back to displayName: it may contain an account name.
const nameSignature = member => JSON.stringify(member?.nickname ?? null);
module.exports = { memberNames, nameSignature };
