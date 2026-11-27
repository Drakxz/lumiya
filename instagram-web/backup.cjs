// Consistent SQLite backup, including WAL state; does not copy live .sqlite files blindly.
require("dotenv").config({quiet:true});
const {DatabaseSync,backup}=require("node:sqlite");
const fs=require("node:fs/promises"),path=require("node:path");
(async()=>{
  const target=process.argv[2];if(!target)throw new Error("Uso: node instagram-web/backup.cjs DIRETORIO_PRIVADO");
  await fs.mkdir(target,{recursive:true,mode:0o700});
  const source=process.env.CALL_STATS_FILE||path.join(__dirname,"..","database","call-stats.sqlite");
  const db=new DatabaseSync(source,{readOnly:true});
  try{await backup(db,path.join(target,`call-stats-${Date.now()}.sqlite`));}finally{db.close();}
  console.log("Snapshot SQLite criado. Consulte o README para preservar também o estado legado e os arquivos privados.");
})().catch(()=>{console.error("Falha no backup. Verifique destino, permissões e versão do Node.");process.exitCode=1;});
