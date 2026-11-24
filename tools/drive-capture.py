"""Capture a raised-arm crest approach, brake, house slew, descent and reverse.

Build private baseline and candidate pages with tools/gauntlet-build.mjs first.
Both drivers brake at the same location. Slew, descent and reverse inputs are
timed from that crossing. Both stop reversing at the same return marker.
"""
import base64
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/os.environ.get('SAND_GAUNTLET_DIR','.work/drive-gauntlet')
PUBLIC=ROOT/'review'/'drive'
FRONT=dict(eye=[5.7,4.2,-23],look=[5.3,3.8,0],width=17.5,isolate=False)
NEAR=dict(eye=[3.7,2,-12],look=[5.3,2.4,0],width=9.2,isolate=False)
FAR=dict(eye=[5.7,2.2,13],look=[5.3,2.3,0],width=9.2,isolate=False)
OVER=dict(eye=[11,11,-9],look=[5,1.3,0],width=12,isolate=False)
STAGES={'approach':FRONT,'brake':NEAR,'opposite':FAR,'slew':OVER,'descent':FRONT,'reverse':OVER}

def capture(browser,side):
    folder=WORK/'private'/side
    page=browser.new_page(viewport={'width':1440,'height':864})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto((folder/'capture.html').as_uri()+'?yard=quarry')
    page.wait_for_function('window.gauntlet')
    page.evaluate("""()=>{
      const g=window.gauntlet;
      g.reset();window.driveGate=null;window.reverseGate=null;
      window.driveStep=()=>{
        const t=g.state().frame;
        if(t===0)g.key('KeyW',true);
        if(t===36)g.key('KeyW',false);
        if(t===60)g.key('ArrowUp',true);
        const state=g.state();
        if(window.driveGate===null && state.base.x>=5.18){
          window.driveGate=t; g.key('ArrowUp',false);
        }
        const since=window.driveGate===null?-1:t-window.driveGate;
        if(since===90)g.key('KeyQ',true);
        if(since===176)g.key('KeyQ',false);
        if(since===235)g.key('ArrowUp',true);
        if(since===382){g.key('ArrowUp',false);g.key('ArrowDown',true);}
        if(since>382 && window.reverseGate===null && state.base.x<=5.65){
          window.reverseGate=t;g.key('ArrowDown',false);
        }
        g.advance(1);
      };
    }""")
    review=folder/'drive';review.mkdir(exist_ok=True)
    snapshots={};trace=[];nframes=0
    with subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','image2pipe',
         '-framerate','20','-c:v','mjpeg','-i','-','-an','-c:v','libx264','-pix_fmt','yuv420p',
         '-preset','fast','-crf','17','-movflags','+faststart',str(review/'drive.mp4')],stdin=subprocess.PIPE) as encoder:
        while nframes<600:
            packet=page.evaluate("""({front, stages, done})=>{
              const g=window.gauntlet, stills={}, movie=[], trace=[];
              function still(name,s){
                if(done.includes(name)||stills[name])return;
                stills[name]={image:g.photograph(stages[name]),state:s};
              }
              for(let frame=0;frame<8;frame++){
                const s=window.sandLab.state(), dt=window.driveGate===null?-1:s.frame-window.driveGate;
                if(s.base.x>=2.9)still('approach',s);
                if(dt>=76){still('brake',s);still('opposite',s);}
                if(dt>=212)still('slew',s);
                if(dt>=418)still('descent',s);
                if(window.reverseGate!==null)still('reverse',s);
                movie.push(g.photograph(front,true));
                if(s.frame%15===0)trace.push({frame:s.frame,base:s.base,pose:s.pose,yaw:s.trackYaw,body:s.chassis,
                   terrainBalance:s.massError,root:g.state().rootEuler});
                for(let sub=0;sub<3;sub++)window.driveStep();
                if(window.reverseGate!==null && s.frame-window.reverseGate>=90)break;
              }
              return {stills,movie,trace,gate:window.driveGate,back:window.reverseGate,t:g.state().frame};
            }""",dict(front=FRONT,stages=STAGES,done=list(snapshots)))
            for key,item in packet['stills'].items():
                im=base64.b64decode(item['image'])
                (review/(key+'.png')).write_bytes(im)
                snapshots[key]=item['state']
            for frame in packet['movie']:encoder.stdin.write(base64.b64decode(frame))
            trace+=packet['trace'];nframes+=len(packet['movie'])
            if packet['back'] and packet['t']-packet['back']>=90:break
        encoder.stdin.close();assert encoder.wait()==0
    assert len(snapshots)==len(STAGES) and packet['gate'] and not errors,(side,list(snapshots),errors)
    assert all(s['terrainBalance']==0 for s in trace)
    if side=='candidate':
        page.evaluate("document.querySelector('#forces').click()")
        frame=base64.b64decode(page.evaluate('f=>gauntlet.photograph(f)',FRONT))
        (review/'forces.png').write_bytes(frame)
    data=dict(gate=packet['gate'],reverseStop=packet['back'],samples=trace,stills=snapshots,frames=nframes)
    (review/'trace.json').write_text(json.dumps(data,indent=2),encoding='utf8')
    print(side,'brake at tick',data['gate'],'movie frames',nframes,flush=True);page.close()
    return review

if __name__=='__main__':
    PUBLIC.mkdir(exist_ok=True)
    with sync_playwright() as pw:
        browser=pw.chromium.launch(channel='chrome',args=['--enable-gpu','--use-angle=d3d11'])
        folders={s:capture(browser,s) for s in ('baseline','candidate')}
        browser.close()
    blind=WORK/'drive-blind';blind.mkdir(exist_ok=True)
    pair=list(folders);secrets.SystemRandom().shuffle(pair);key=dict(zip(['A','B'],pair))
    (WORK/'private'/'drive-key.json').write_text(json.dumps(key),encoding='utf8')
    for letter,side in key.items():
        dst=blind/letter;dst.mkdir(exist_ok=True)
        for name in STAGES:shutil.copyfile(folders[side]/(name+'.png'),dst/(name+'.png'))
        shutil.copyfile(folders[side]/'drive.mp4',dst/'drive.mp4')
    for name in STAGES:
        for side,folder in folders.items():
            with Image.open(folder/(name+'.png')) as im:im.save(PUBLIC/(side+'-'+name+'.webp'),quality=87,method=5)
    with Image.open(folders['candidate']/'forces.png') as im:im.save(PUBLIC/'contact.webp',quality=88)
    for side,folder in folders.items():shutil.copyfile(folder/'drive.mp4',PUBLIC/(side+'.mp4'))
