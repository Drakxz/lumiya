const {randomUUID}=require("node:crypto");

class CenterStore {
  constructor(db) {
    this.db=db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS command_center_panels(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,
        channelId TEXT NOT NULL,messageId TEXT,hash TEXT NOT NULL DEFAULT '',UNIQUE(guildId,channelId));
      CREATE TABLE IF NOT EXISTS command_center_sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL,expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS command_center_remote(name TEXT PRIMARY KEY,id TEXT NOT NULL);
    `);
  }
  session(state) {
    this.db.prepare("INSERT INTO command_center_sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,expiresAt=excluded.expiresAt")
      .run(state.id,JSON.stringify(state),Date.now()+24*3600000);
    return state;
  }
  getSession(id) {
    const row=this.db.prepare("SELECT data FROM command_center_sessions WHERE id=? AND expiresAt>?").get(id,Date.now());
    return row?JSON.parse(row.data):null;
  }
  panel(guildId,channelId) {return this.db.prepare("SELECT * FROM command_center_panels WHERE guildId=? AND channelId=?").get(guildId,channelId);}
  panels() {return this.db.prepare("SELECT * FROM command_center_panels").all();}
  preparePanel(guildId,channelId) {
    this.db.prepare("INSERT OR IGNORE INTO command_center_panels(id,guildId,channelId) VALUES(?,?,?)").run(randomUUID(),guildId,channelId);
    return this.panel(guildId,channelId);
  }
  savePanel(id,messageId,hash) {this.db.prepare("UPDATE command_center_panels SET messageId=?,hash=? WHERE id=?").run(messageId,hash,id);}
  publicationSession(id) {
    const row=this.db.prepare("SELECT * FROM command_center_panels WHERE id=?").get(id);
    return row?{id:row.id,guildId:row.guildId,userId:null,permanent:true,view:"home",group:0,page:1,category:null,query:"",detail:null}:null;
  }
  remoteAdapter() {
    return {
      list:()=>this.db.prepare("SELECT * FROM command_center_remote").all(),
      set:(name,id)=>this.db.prepare("INSERT INTO command_center_remote VALUES(?,?) ON CONFLICT(name) DO UPDATE SET id=excluded.id").run(name,id),
      remove:name=>this.db.prepare("DELETE FROM command_center_remote WHERE name=?").run(name)
    };
  }
  prune() {this.db.prepare("DELETE FROM command_center_sessions WHERE expiresAt<=?").run(Date.now());}
}
module.exports={CenterStore};
