const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const express=require('express');
const {chromium}=require('playwright-core');
const {PDFDocument,StandardFonts}=require('pdf-lib');
test('static preview builds and runs Cut Label with no API, database, login or external requests',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'static-preview-'));
 let server,browser;
 try {
  execFileSync(process.execPath,['scripts/build-preview.mjs'],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,PREVIEW_OUT_DIR:tmp},stdio:'pipe'});
  server=express().use(express.static(tmp)).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  const page=await browser.newPage({acceptDownloads:true});const unexpected=[],errors=[];
  page.on('request',r=>{if(r.url().startsWith('http')&&(!r.url().startsWith(origin)||new URL(r.url()).pathname.startsWith('/api/')))unexpected.push(r.url());});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);
  assert.equal(await page.getByRole('heading',{name:'Cut Label',exact:true}).isVisible(),true);
  const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica),pg=doc.addPage([288,432]);
  const id='abcdef0123456789abcdef01';pg.drawText('Order # '+id,{x:20,y:360,size:9,font});pg.drawText('USPS TRACKING #\n9434650110837019925838',{x:20,y:100,size:10,font});
  await page.locator('input[type=file]').setInputFiles({name:'sample.pdf',mimeType:'application/pdf',buffer:Buffer.from(await doc.save())});
  await page.waitForSelector('.page');assert.equal(await page.locator('.page input').inputValue(),id);
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Xuất trang này'}).click();
  const download=await pending;assert.equal(download.suggestedFilename(),id+'.pdf');await download.saveAs(path.join(tmp,'export.pdf'));
  const exported=await PDFDocument.load(await fs.readFile(path.join(tmp,'export.pdf')));assert.deepEqual(exported.getPage(0).getSize(),{width:288,height:432});
  await page.getByRole('button',{name:/Get Label/}).click();assert.equal(await page.getByRole('button',{name:'Đăng nhập bằng Google'}).count(),0);
  assert.equal(await page.getByText('Gmail/Sheets sẽ được bổ sung sau',{exact:true}).isVisible(),true);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 } finally {await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await fs.rm(tmp,{recursive:true,force:true});}
});
