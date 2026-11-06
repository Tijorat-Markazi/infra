import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
const source=readFileSync(new URL('../Caddyfile',import.meta.url),'utf8');
const binary=process.env.CADDY_BIN||'caddy';
const filter=readFileSync(new URL('../edge-log-filter.caddy',import.meta.url),'utf8');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('actual TLS site template validates with HTTP-01 and a literal independent hostname',()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'tm-edge-validate-'));
  try{
    const file=path.join(folder,'Caddyfile');
    writeFileSync(file,source.replaceAll('{$DOMAIN}','example.test'));
    const result=spawnSync(binary,['adapt','--config',file,'--adapter','caddyfile','--validate'],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);
    const json=JSON.parse(result.stdout);
    assert.ok(json.apps.tls.automation.policies.some(p=>p.issuers.some(i=>i.challenges?.['tls-alpn']?.disabled===true)));
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test('edge accepts Cloudflare client identity only from matching peers and overwrites forged headers',{timeout:20000},async()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'tm-edge-'));
  const upstream=http.createServer((req,res)=>{if(req.url.startsWith('/api/force-error')){req.socket.destroy();return;}res.end(JSON.stringify({url:req.url,headers:req.headers}));});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const config='{\n admin off\n persist_config off\n'+filter+'}\n'+source.replaceAll('{$DOMAIN}',`http://127.0.0.1:${port}`)
    .replace(/\ttls \{[\s\S]*?\n\t\}\n/,'')
    .replace(/@cloudflare remote_ip[^\n]+/,'@cloudflare remote_ip 127.0.0.2/32')
    .replace('tijoratmarkazi-frontend:8080',`127.0.0.1:${upstream.address().port}`);
  const file=path.join(folder,'Caddyfile');writeFileSync(file,config);
  const child=spawn(binary,['run','--config',file,'--adapter','caddyfile'],{stdio:['ignore','pipe','pipe']});
  let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',v=>{logs+=v.toString();});
  const exited=once(child,'exit');
  function request(peer,target='/api/probe?x=1'){return new Promise((resolve,reject)=>{
    const req=http.get({hostname:'127.0.0.1',port,localAddress:peer,path:target,signal:AbortSignal.timeout(1000),headers:{'CF-Connecting-IP':'203.0.113.25','X-Real-IP':'1.1.1.1','X-Forwarded-For':'1.1.1.1','X-TM-Client-IP':'1.1.1.1','X-Forwarded-Proto':'http',Referer:'https://example.test/private?private-referer-token'}},res=>{let body='';res.on('data',b=>{body+=b;});res.on('end',()=>resolve(res.statusCode===200?JSON.parse(body):{status:res.statusCode,body}));});
    req.on('error',reject);
  });}
  try{
    let ready=false;
    for(let i=0;i<50;i++){assert.equal(child.exitCode,null,logs);try{await request('127.0.0.1');ready=true;break;}catch{await pause(100);}}
    assert.ok(ready,logs);
    for(const [peer,expected] of [['127.0.0.1','127.0.0.1'],['127.0.0.2','203.0.113.25']]){
      const result=await request(peer);
      assert.equal(result.url,'/api/probe?x=1');
      assert.equal(result.headers['x-real-ip'],expected);
      assert.equal(result.headers['x-forwarded-for'],expected);
      assert.equal(result.headers['x-forwarded-proto'],'https');
      assert.equal(result.headers['cf-connecting-ip'],undefined);
      assert.equal(result.headers['x-tm-client-ip'],undefined);
    }
    const failure=await request('127.0.0.1','/api/force-error?t=private-query-token&token=private-reset-token');
    assert.equal(failure.status,502);
    await pause(150);
    for(const secret of ['private-query-token','private-reset-token','private-referer-token'])assert.equal(logs.includes(secret),false,logs);
  }finally{
    if(child.exitCode===null)child.kill();await exited;
    upstream.closeAllConnections();await new Promise(r=>upstream.close(r));
    rmSync(folder,{recursive:true,force:true});
  }
});
