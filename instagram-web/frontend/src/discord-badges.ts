// Native Discord artwork served locally; attribution is shipped with the images.
const files:Record<string,string>={
  Staff:"staff",Partner:"partnered_server_owner",Hypesquad:"hypesquad_events",
  HypeSquadOnlineHouse1:"hypesquad_bravery",HypeSquadOnlineHouse2:"hypesquad_brilliance",
  HypeSquadOnlineHouse3:"hypesquad_balance",BugHunterLevel1:"bug_hunter_level_1",
  BugHunterLevel2:"bug_hunter_level_2",PremiumEarlySupporter:"early_supporter",
  VerifiedDeveloper:"early_verified_developer",CertifiedModerator:"certified_moderator",
  ActiveDeveloper:"active_developer",Nitro:"nitro",Boost:"boosting_1_months"
};
export const discordBadgeImage=(id:string,icon?:string)=>{
  if(icon&&/^https:\/\/cdn\.discordapp\.com\/badge-icons\/[a-f0-9]{32,64}\.png$/i.test(icon))return icon;
  const file=files[id.replace(/^discord:/,"")];
  return file?`/discord-badges/${file}.png`:null;
};
