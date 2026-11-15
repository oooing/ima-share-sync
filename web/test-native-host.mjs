import test from 'node:test';
import assert from 'node:assert/strict';
import { handleIdentity } from './live-identity.mjs';
async function request(body,extra={}){
 let status=0,response='';const req={method:'POST',headers:{host:'127.0.0.1:17664','content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify(body);},...extra};
 const res={setHeader(){},writeHead(code){status=code;},end(text){response=text;}};
 await handleIdentity(req,res);return {status,value:JSON.parse(response)};
}
test('live native transport rejects malformed envelopes before constructing a native worker',async()=>{
 for(const args of [[],[null],['not-object'],[[]],[{},{}]]){
  const response=await request({operation:'nativeIdentity',args});assert.equal(response.status,400);assert.match(response.value.error,/请求无效/);
 }
});
test('live source endpoint still restricts request method, content type and origin',async()=>{
 assert.equal((await request({},{method:'GET'})).status,405);
 assert.equal((await request({},{headers:{host:'127.0.0.1:17664','content-type':'text/plain'}})).status,405);
 assert.equal((await request({},{headers:{host:'127.0.0.1:17664','content-type':'application/json',origin:'https://example.invalid'}})).status,403);
 assert.equal((await request({operation:'sync',args:[]})).status,400);
});