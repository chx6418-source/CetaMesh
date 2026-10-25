import {NodeDatabase} from './helpers/NodeDatabase';
import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';
import {SqliteTrustRepository} from '../data/repositories/SqliteTrustRepository';
const trust={deviceId:'peer-1',deviceName:'Desktop',publicKey:'B'+'A'.repeat(86)+'=',endpoint:'https://desktop.example',localDeviceId:'mobile-1',localPublicKey:'B'+'A'.repeat(86)+'=',createdAt:'2026-09-30T00:00:00.000Z'};
it('upgrades v2 without losing memory, persists replay denial and trust deletion',async()=>{
 const db=new NodeDatabase();await migrateDatabase(db,appMigrations.filter(m=>m.version<=2));
 await db.executeAsync("INSERT INTO memories(id,kind,content,created_at,updated_at) VALUES('memory-1','local','retained','now','now')");
 await migrateDatabase(db,appMigrations);await migrateDatabase(db,appMigrations);
 const repo=new SqliteTrustRepository(db);await repo.consume('peer-1','invite-1',trust.createdAt,'a'.repeat(64));
 await expect(new SqliteTrustRepository(db).consume('peer-1','invite-1',trust.createdAt,'a'.repeat(64))).rejects.toMatchObject({code:'unauthorized'});
 await repo.save(trust);expect(await repo.get('peer-1')).toEqual(trust);await repo.remove('peer-1');expect(await repo.get('peer-1')).toBeUndefined();
 expect((await db.executeAsync('SELECT content FROM memories')).results[0].content).toBe('retained');
 expect((await db.executeAsync('SELECT * FROM pairing_used')).results[0]).not.toHaveProperty('token');await db.close();
});
it('does not overwrite previously trusted keys and requires positive authorization',async()=>{
 const db=new NodeDatabase();await migrateDatabase(db,appMigrations);const repo=new SqliteTrustRepository(db);
 await repo.save(trust);await expect(repo.save({...trust,publicKey:'B'+'C'.repeat(85)+'A='})).rejects.toMatchObject({code:'sync_conflict'});
 expect(await repo.list()).toEqual([trust]);await db.close();
});
it('keeps consumed invitations and public trust after file-backed close/reopen',async()=>{
 const {mkdtempSync,rmSync}=require('node:fs');const {tmpdir}=require('node:os');const {join}=require('node:path');
 const directory=mkdtempSync(join(tmpdir(),'cetamesh-m3-test-')),path=join(directory,'isolated.sqlite');
 try{
  const first=new NodeDatabase(path);await migrateDatabase(first,appMigrations);const repo=new SqliteTrustRepository(first);
  await repo.consume('peer-1','invite-1',trust.createdAt,'a'.repeat(64));await repo.save(trust);await first.close();
  const second=new NodeDatabase(path);await migrateDatabase(second,appMigrations);const restored=new SqliteTrustRepository(second);
  expect(await restored.get('peer-1')).toEqual(trust);await expect(restored.consume('peer-1','invite-1',trust.createdAt,'a'.repeat(64))).rejects.toMatchObject({code:'unauthorized'});
  await second.close();
 }finally{rmSync(directory,{recursive:true,force:true});}
});
