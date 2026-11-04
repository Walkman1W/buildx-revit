// Run only against a freshly initialized disposable PostgreSQL instance with
// buildx-license-test-fixture.sql and buildx-license-migration-draft.sql loaded.
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const psql=process.env.BUILDX_TEST_PSQL, port=process.env.BUILDX_TEST_PORT;
if(!psql||!port)throw new Error('Explicit isolated PostgreSQL executable and port required');
function query(sql,{failure=false}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(psql,['-X','-qAt','-h','127.0.0.1','-p',port,'-U',process.env.USERNAME,'-d',process.env.BUILDX_TEST_DB||'postgres','-v','ON_ERROR_STOP=1']);
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
    child.on('error',reject);child.on('close',n=>{if((n!==0)!==failure)reject(new Error(`Unexpected SQL outcome: ${stderr}`));else resolve(stdout.trim());});child.stdin.end(sql);
  });
}
const actor=(id,sql)=>`set role authenticated; set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000${id}'; ${sql}`;
const status=async id=>JSON.parse(await query(actor(id,'select public.buildx_license_status();')));
assert.equal((await status(1)).status,'unactivated');
await query('set role anon; select public.buildx_license_status();',{failure:true});
await query(actor(1,'select * from buildx_private.invites;'),{failure:true});
await query(actor(1,'select buildx_private.create_invite(\'trial\',3600,now()+interval \'1 day\',1);'),{failure:true});
await query("set role authenticated; set request.jwt.claims='{\"is_anonymous\":true}'; set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001'; select public.buildx_license_status();",{failure:true});
const code=await query("select buildx_private.create_invite('trial',3600,now()+interval '1 day',1);");
assert.match(code,/^[0-9a-f]{64}$/);
const results=await Promise.all([1,2].map(id=>query(actor(id,`select public.buildx_redeem_invite('${code}');`)).then(JSON.parse)));
assert.deepEqual(results.map(x=>x.status).sort(),['trial','unactivated']);
const winner=results[0].status==='trial'?1:2, loser=winner===1?2:1;
assert.equal(JSON.parse(await query(actor(winner,`select public.buildx_redeem_invite('${code}');`))).status,'trial');
assert.equal((await status(loser)).status,'unactivated');
assert.equal(await query('select count(*) from buildx_private.redemptions;'),'1');
await query(`update buildx_private.licenses set disabled_at=now() where user_id='00000000-0000-0000-0000-00000000000${winner}';`);
assert.equal((await status(winner)).status,'disabled');
await query(`update buildx_private.licenses set disabled_at=null, starts_at=now()-interval '2 hours', ends_at=now()-interval '1 hour' where user_id='00000000-0000-0000-0000-00000000000${winner}';`);
assert.equal((await status(winner)).status,'expired');
const expired=await query("select buildx_private.create_invite('trial',60,now()+interval '1 day',1);");
await query("update buildx_private.invites set expires_at=now()-interval '1 second' where max_uses=1 and id not in (select invite_id from buildx_private.redemptions);");
assert.equal(JSON.parse(await query(actor(3,`select public.buildx_redeem_invite('${expired}');`))).status,'unactivated');
const codes=await Promise.all([1,2].map(()=>query("select buildx_private.create_invite('trial',3600,now()+interval '1 day',1);")));
await Promise.all(codes.map(value=>query(actor(4,`select public.buildx_redeem_invite('${value}');`))));
assert.equal(await query("select count(*) from buildx_private.redemptions where user_id='00000000-0000-0000-0000-000000000004';"),'1');
console.log('Isolated database checks passed: authorization, anonymity, concurrent capacity, duplicate redemption, expiry and revocation.');
