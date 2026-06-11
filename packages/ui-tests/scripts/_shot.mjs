import { chromium } from '@playwright/test';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1100,height:620}});
await p.goto('http://localhost:5274/?physics=couple',{waitUntil:'networkidle'});
await sleep(2500);
await p.screenshot({path:'/tmp/live_couple.png'});
// dump the fill of the first track piece's body path
const fills=await p.evaluate(()=>{
  const paths=[...document.querySelectorAll('[data-piece-id] path')].slice(0,4).map(p=>p.getAttribute('fill'));
  const defs=!!document.querySelector('#tf-wood');
  return {fills, hasWoodDef:defs};
});
console.log(JSON.stringify(fills));
await b.close();
