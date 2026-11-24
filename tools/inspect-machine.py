"""Render the rig at true orthographic stations and check opaque surface order.

Requires Python Playwright and a Chromium installation. An optional argument
sets the output directory. Images and JSON default to the OS temp directory.
"""
import base64
import json
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.gettempdir()) / 'sand-rig-review'
STUDIO = """<!doctype html><style>*{margin:0}canvas{display:block}</style><script type=module>
import * as T from '/three.module.js';
import {createMachine} from '/machine.js';
const scene=new T.Scene(), rig=createMachine(T), size=640;
scene.background=new T.Color('#aab9ba');
scene.add(rig.root,new T.HemisphereLight(0xfff5e7,0xb9b7b3,2.2));
const key=new T.DirectionalLight(0xffead4,2.1);key.position.set(3,8,6);scene.add(key);
const rim=new T.DirectionalLight(0xc8e3ef,1.2);rim.position.set(-4,4,-5);scene.add(rim);
const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
renderer.setSize(size,size);renderer.toneMapping=T.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const camera=new T.OrthographicCamera(-5,5,5,-5,.01,100);
const center=new T.Vector3(2,2.2,0), gl=renderer.getContext();
const opaque=[], original=new Map();
rig.root.traverse(mesh=>{
  if(!mesh.isMesh || mesh.material.transparent || mesh.material.depthWrite===false) return;
  const geo=mesh.geometry, first=geo.index, count=first?.count??geo.attributes.position.count;
  const backwards=[];
  for(let i=count-3;i>=0;i-=3) for(let j=0;j<3;j++) backwards.push(first?first.getX(i+j):i+j);
  original.set(mesh,{first,backwards:new T.Uint32BufferAttribute(backwards,1),order:mesh.renderOrder});
  opaque.push(mesh);
});
function reverse(on) {
  opaque.forEach((mesh,i)=>{
    const {first,backwards,order}=original.get(mesh);
    mesh.geometry.setIndex(on?backwards:first);
    mesh.renderOrder=on?opaque.length-i:order;
  });
}
function pixels(){
  renderer.render(scene,camera);
  const bytes=new Uint8Array(size*size*4);
  gl.readPixels(0,0,size,size,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
  return bytes;
}
function difference(a,b){
  let changed=0;
  const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
  const ctx=canvas.getContext('2d'),overlay=ctx.createImageData(size,size);
  for(let i=0;i<a.length;i+=4) {
    const d=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));
    if(d>12) changed++;
    const x=(i/4)%size,y=Math.floor(i/4/size),j=((size-1-y)*size+x)*4;
    const grey=Math.floor((a[i]+a[i+1]+a[i+2])/4);
    overlay.data.set(d>12?[255,0,255,255]:[grey,grey,grey,255],j);
  }
  ctx.putImageData(overlay,0,0);
  window.overlay=canvas.toDataURL('image/png').split(',')[1];
  return changed;
}
window.review=({dir,pose})=>{
  rig.pose(pose);
  camera.position.copy(center).addScaledVector(new T.Vector3(...dir).normalize(),16);
  camera.up.set(0,1,0);
  if(Math.abs(dir[1])===1 && dir[0]===0 && dir[2]===0) camera.up.set(0,0,-1);
  camera.lookAt(center);camera.updateProjectionMatrix();
  const a=pixels();reverse(true);const b=pixels();reverse(false);renderer.render(scene,camera);
  return difference(a,b);
};
window.control=()=>{
  rig.root.visible=false;
  camera.position.set(0,0,4);camera.up.set(0,1,0);camera.lookAt(0,0,0);
  const geometry=new T.PlaneGeometry(2,2);
  const cards=[0xff0000,0x0000ff].map(color=>{
    const m=new T.Mesh(geometry,new T.MeshBasicMaterial({color}));scene.add(m);return m;
  });
  cards[1].renderOrder=1;const a=pixels();cards[0].renderOrder=2;const b=pixels();
  cards.forEach(m=>scene.remove(m));rig.root.visible=true;
  return difference(a,b);
};
window.ready=true;
</script>"""


class Preview(BaseHTTPRequestHandler):
    def do_GET(self):
        sources = {
            '/machine.js': ROOT / 'web/machine.js',
            '/three.module.js': ROOT / 'node_modules/three/build/three.module.js',
            '/three.core.js': ROOT / 'node_modules/three/build/three.core.js',
        }
        if self.path == '/':
            body, mime = STUDIO.encode(), 'text/html'
        elif self.path in sources:
            body, mime = sources[self.path].read_bytes(), 'application/javascript'
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    views = {'front':[1,0,0], 'rear':[-1,0,0], 'cab':[0,0,1], 'service':[0,0,-1],
             'top':[0,1,0], 'under':[0,-1,0], 'oblique':[0.7,0.4,1]}
    poses = {'dig':dict(boom=.37,stick=-1.30,curl=.27),
             'carry':dict(boom=.72,stick=-1.55,curl=.97,load=.9),
             'dump':dict(boom=.83,stick=-1.50,curl=-.52)}
    report = {}
    with ThreadingHTTPServer(('127.0.0.1',0), Preview) as server:
        Thread(target=server.serve_forever,daemon=True).start()
        try:
            with sync_playwright() as api:
                browser=api.chromium.launch(args=['--enable-gpu','--use-angle=d3d11'])
                page=browser.new_page(viewport={'width':640,'height':640})
                page.goto(f'http://127.0.0.1:{server.server_port}/')
                page.wait_for_function('window.ready === true')
                report['controlChangedPixels']=page.evaluate('window.control()')
                report['orderDifferences']={}
                for pose_name,pose in poses.items():
                    for name,axis in views.items():
                        changed=page.evaluate('p => window.review(p)',{'dir':axis,'pose':pose})
                        report['orderDifferences'][f'{pose_name}-{name}']=changed
                        page.screenshot(path=str(OUTPUT/f'{pose_name}-{name}.png'))
                        if changed:
                            diff=page.evaluate('window.overlay')
                            (OUTPUT/f'{pose_name}-{name}-order.png').write_bytes(base64.b64decode(diff))
                browser.close()
        finally:
            server.shutdown()
    report['pixelsPerView']=640*640
    (OUTPUT/'surfaces.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    if report['controlChangedPixels']<1000 or max(report['orderDifferences'].values())>120:
        raise SystemExit('Draw-order check requires visual review.')


if __name__ == '__main__':
    main()
