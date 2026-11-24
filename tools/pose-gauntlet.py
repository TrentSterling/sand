"""Capture the same real quarry input sequence and cameras on two revisions.

  node tools/gauntlet-build.mjs baseline 677fca8
  python tools/pose-gauntlet.py baseline
  npm run build
  node tools/gauntlet-build.mjs candidate
  python tools/pose-gauntlet.py candidate
  python tools/pose-gauntlet.py plates

For a fresh review set SAND_GAUNTLET_DIR to a new output directory before
both build and capture. Relative paths resolve from the repository root.
Give reviewers only its blind subdirectory. The private subdirectory holds
the assignment, source hashes, pose receipts and common camera transforms.
"""
import argparse
import base64
import json
import os
import secrets
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageStat
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
WORK = (ROOT / os.environ.get('SAND_GAUNTLET_DIR', '.work/gauntlet')).resolve()
PRIVATE = WORK / 'private'
FRAMING = PRIVATE / 'cameras.json'
SIZE = (1600, 960)


def view(eye, center, *, width=None, tip=False, chassis=False, isolate=False):
    return dict(eye=eye, center=center, width=width, tip=tip, chassis=chassis, isolate=isolate)


GAME = view([9.55, 6.45, 12.8], [1.60, 2.00, 1.35], chassis=True)
CAB = view([0, 0.15, 13], [1.55, 2.85, 0], width=12.6)
SERVICE = view([-1.5, 1.50, -10.7], [1.45, 1.95, 0])
HEAD = view([13, 0.50, 0], [1.5, 2.85, 0], width=12.6, isolate=True)
REAR = view([-9.5, 3.1, 5.0], [0.60, 2.8, 0])
OVER = view([2.7, 10.4, 7.9], [1.3, 1.4, 0])
UNDER = view([-2.8, -4.25, 3.1], [0.0, 0.82, 0.0], width=7.4, chassis=True, isolate=True)
TEETH = view([2.8, 1.15, 2.3], [-0.03, 0.20, 0], tip=True)
HYDRAULICS = view([0.95, 0.6, -7.15], [1.95, 4.28, 0], width=6.75)
DRIVE = view([3.8, 1.2, 7.3], [0.4, 1.30, 0], chassis=True)


def json_file(path):
    return json.loads(path.read_text(encoding='utf-8'))


def save_json(path, value):
    path.write_text(json.dumps(value, indent=2), encoding='utf-8')


def record(side):
    job = PRIVATE / side
    frames_dir = job / 'frames'
    frames_dir.mkdir(parents=True, exist_ok=True)
    release = job / 'capture.html'
    if not release.is_file():
        raise SystemExit('Prepare this revision with gauntlet-build.mjs first.')
    cameras = {} if side == 'baseline' else json_file(FRAMING)
    shots = []
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='chrome', headless=True, args=[
            '--enable-gpu', '--use-angle=d3d11', '--disable-background-timer-throttling',
        ])
        page = browser.new_page(viewport={'width': SIZE[0], 'height': SIZE[1]}, device_scale_factor=1)
        page.on('pageerror', lambda exc: errors.append(str(exc)))
        page.goto(release.as_uri(), wait_until='load')
        page.wait_for_function("Boolean(window.gauntlet)", timeout=60000)
        gpu = page.evaluate('gauntlet.rendererName')
        if any(name in gpu.lower() for name in ('swiftshader', 'llvmpipe', 'software renderer')):
            raise RuntimeError(f'Hardware rendering required: {gpu}')

        def call(method, arg=None):
            return page.evaluate('([method,arg])=>gauntlet[method](arg)', [method, arg])

        def photograph(number, label, camera, category='working views'):
            state = call('state')
            assert state['massError'] == 0, (number, state)
            if side == 'baseline':
                cameras[number] = call('frameFor', camera)
            data = base64.b64decode(call('photograph', cameras[number]), validate=True)
            dest = frames_dir / (number + '.png')
            dest.write_bytes(data)
            with Image.open(dest) as shot:
                assert shot.size == SIZE, shot.size
                assert sum(ImageStat.Stat(shot.convert('RGB').resize((64, 40))).stddev) > 12, number
            shots.append(dict(id=number, label=label, category=category, state=state))

        def temporal(number, label):
            photograph(number, label, GAME, 'dig to dump')

        def key(code, down):
            page.evaluate('([code, down])=>gauntlet.key(code, down)', [code, down])

        temporal('T01', 'At the bank')
        call('command', 'dig')
        call('advance', 141)
        temporal('T02', 'Teeth entering the bank')
        call('advance', 50)
        photograph('01', 'Mid-cut · cab side', CAB)
        temporal('T03', 'Drawing the stick in')
        state = call('finish')
        assert state['load'] > 0, 'Dig did not load the bucket'
        photograph('02', 'Full cut · elevated', OVER)
        temporal('T04', 'Bucket curled')
        call('command', 'lift')
        call('advance', 27)
        photograph('03', 'Lifting · service side', SERVICE)
        temporal('T05', 'Lifting clear')
        state = call('finish')
        assert state['load'] > 0
        photograph('04', 'Carry · cab side', CAB)
        photograph('05', 'Carry · front isolated', HEAD)
        photograph('06', 'Carry · teeth and load', TEETH)
        photograph('07', 'Carry · rear quarter', REAR)
        photograph('08', 'Carry · cylinders', HYDRAULICS)
        photograph('09', 'Carry · undercarriage isolated', UNDER)
        call('command', 'swing')
        call('advance', 113)
        photograph('10', 'Swing · elevated', OVER)
        temporal('T06', 'Swinging the load')
        call('finish')
        temporal('T07', 'Over the bay')
        call('command', 'dump')
        for _ in range(97):
            state = call('advance', 1)
            if state['air'] >= 24:
                break
        assert state['air'] >= 24, 'No parcel stream in dump'
        photograph('11', 'Dump · bucket mouth and stream', TEETH)
        temporal('T08', 'Load leaving the lip')
        # The bucket can shed a few grains while braking over the bay.
        # Require fresh deposited volume after opening, with sand still in flight.
        initial_deposit = state['bay']
        for _ in range(97):
            state = call('advance', 1)
            if state['bay'] >= initial_deposit + 1600 and state['air'] > 0:
                break
        assert state['bay'] >= initial_deposit + 1600 and state['air'] > 0, 'No sustained deposit'
        photograph('12', 'Dump · service side', SERVICE)
        temporal('T09', 'Stream landing in bay')
        photograph('14', 'Dump · lip to deposit', view([8.1, 3.4, 5.3], [0.15, 1.9, 4.4], width=8.4, chassis=True))
        call('finish')
        state = call('advance', 100)
        assert state['bay'] > 0, 'Load missed the bay'
        temporal('T10', 'Sand settled')
        state = call('reset')
        key('ArrowUp', True)
        try:
            state = call('advance', 115)
        finally:
            key('ArrowUp', False)
        assert state['manual'] and state['base']['x'] > 3, state
        assert max(abs(state['rootEuler'][i]) for i in (0,2)) > 0.07, state
        photograph('13', 'Manual travel · bank slope', DRIVE)
        photograph('15', 'Manual travel · opposite crawler', view([-0.7, 0.9, -8.8], [0.0, 0.8, 0.0], width=7.8, chassis=True))
        # Each movie frame spans three real 60 Hz simulation steps. Both builds
        # receive the same clicks on the same tick, including time to settle.
        call('reset')
        schedule = {'0': 'dig', '360': 'lift', '435': 'swing', '708': 'dump'}
        movie_path = job / 'excavation.mp4'
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            raise RuntimeError('ffmpeg is required for the matched motion sequence.')
        with subprocess.Popen([
            ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe',
            '-framerate', '20', '-c:v', 'mjpeg', '-i', '-', '-an', '-c:v', 'libx264',
            '-preset', 'fast', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            '-map_metadata', '-1', str(movie_path),
        ], stdin=subprocess.PIPE) as encoder:
            for _ in range(36):
                images = call('motionBatch', dict(lens=cameras['T01'], count=8, schedule=schedule))
                for raw in images:
                    encoder.stdin.write(base64.b64decode(raw, validate=True))
            encoder.stdin.close()
            if encoder.wait():
                raise RuntimeError('ffmpeg did not encode the motion sequence')
        movie_end = call('state')
        assert movie_end['frame'] == 864 and movie_end['bay'] > 0 and movie_end['massError'] == 0
        browser_version = browser.version
        browser.close()
    if errors:
        raise RuntimeError(errors)
    if side == 'baseline':
        save_json(FRAMING, cameras)
    else:
        assert set(cameras) == {s['id'] for s in shots}, 'Camera manifest changed'
    save_json(job / 'poses.json', dict(viewport=SIZE, renderer=gpu, browser=browser_version,
        shots=shots, movie=dict(frames=288, fps=20, size=[800,480], tickSchedule=schedule, end=movie_end)))
    print(f'{len(shots)} full-size captures and 288 consecutive movie frames passed.')


def font(size):
    for path in ('C:/Windows/Fonts/bahnschrift.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'):
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def plate(frames_dir, entries, title, output):
    columns = 2
    width, height = 640, 384
    border, line, header = 12, 35, 60
    rows = (len(entries) + columns - 1) // columns
    canvas = Image.new('RGB', (columns*(width+border)+border, rows*(height+line+border)+header), '#202322')
    draw = ImageDraw.Draw(canvas)
    titleface, face = font(26), font(20)
    draw.text((border, 15), title, font=titleface, fill='#eeeeea')
    for i, shot in enumerate(entries):
        x = border + (i % columns)*(width+border)
        y = header + (i // columns)*(height+line+border)
        with Image.open(frames_dir / (shot['id'] + '.png')) as frame:
            canvas.paste(frame.convert('RGB').resize((width, height), Image.Resampling.LANCZOS), (x, y))
        draw.text((x+3, y+height+5), f"{shot['id']}   {shot['label']}", font=face, fill='#dfdedb')
    canvas.save(output, quality=94, subsampling=0)


def make_blind_set():
    captures = {side: json_file(PRIVATE/side/'poses.json') for side in ('baseline','candidate')}
    base, candidate = captures.values()
    for prop in ('viewport','renderer','browser'):
        if base[prop] != candidate[prop]:
            raise RuntimeError(f'Capture environment changed: {prop}')
    common = [(s['id'],s['label'],s['category']) for s in base['shots']]
    if common != [(s['id'],s['label'],s['category']) for s in candidate['shots']]:
        raise RuntimeError('Shot lists differ')
    key = PRIVATE / 'assignment.json'
    if key.exists():
        assignment = json_file(key)
    else:
        pair = ['baseline','candidate']
        secrets.SystemRandom().shuffle(pair)
        assignment = dict(zip(('A','B'), pair))
        save_json(key, assignment)
    public = WORK / 'blind'
    public.mkdir(exist_ok=True)
    for letter, side in assignment.items():
        dest = public / letter
        dest.mkdir(exist_ok=True)
        for shot in captures[side]['shots']:
            file = shot['id'] + '.png'
            shutil.copyfile(PRIVATE/side/'frames'/file, dest/file)
        shutil.copyfile(PRIVATE/side/'excavation.mp4', dest/'excavation.mp4')
        entries = captures[side]['shots']
        working = [s for s in entries if s['category']=='working views']
        sequence = [s for s in entries if s['category']=='dig to dump']
        for name, shots in [('Structure',working[:7]),('Working details',working[7:]),('Dig to dump',sequence)]:
            plate(dest, shots, f'{letter}  /  {name}', public / f'{letter}-{name.lower().replace(" ","-")}.jpg')
    print(f'Anonymous plates and full-size frames are ready in {public}.')


def export_gallery():
    """Publish the unblinded matched views and a single frame-synchronized movie."""
    gallery = ROOT / 'review'
    gallery.mkdir(exist_ok=True)
    cases = {name: json_file(PRIVATE / name / 'poses.json') for name in ('baseline','candidate')}
    a, b = cases.values()
    assert a['viewport'] == b['viewport'] and a['renderer'] == b['renderer']
    assert [s['id'] for s in a['shots']] == [s['id'] for s in b['shots']]
    sources = {name:json_file(PRIVATE/name/'source.json') for name in cases}
    for name, case in cases.items():
        folder = gallery / name
        folder.mkdir(exist_ok=True)
        for shot in case['shots']:
            with Image.open(PRIVATE/name/'frames'/(shot['id']+'.png')) as frame:
                frame.convert('RGB').save(folder/(shot['id']+'.webp'),quality=84,method=6)
    shots = [dict(id=l['id'], label=l['label'], section=l['category'],
                  frames=[l['state']['frame'],r['state']['frame']],
                  bucket=[l['state']['load'],r['state']['load']],
                  bay=[l['state']['bay'],r['state']['bay']])
             for l,r in zip(a['shots'],b['shots'])]
    save_json(gallery/'captures.json',dict(shots=shots,viewport=a['viewport'],
        renderer=a['renderer'],browser=a['browser'],baseline=sources['baseline']['revision'],
        htmlSha256={k:s['indexSha256'] for k,s in sources.items()},
        seconds=14.4,framesPerSecond=20,ticks=a['movie']['tickSchedule']))
    subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error',
        '-i',str(PRIVATE/'baseline'/'excavation.mp4'),'-i',str(PRIVATE/'candidate'/'excavation.mp4'),
        '-filter_complex','hstack=inputs=2','-an','-c:v','libx264','-crf','18',
        '-preset','fast','-pix_fmt','yuv420p','-movflags','+faststart',str(gallery/'cycle.mp4')],check=True)
    print(f'Exported {len(shots)} pairs and a synchronized movie to {gallery}.')


def check_carrier_stop():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='chrome',args=['--enable-gpu','--use-angle=d3d11'])
        page=browser.new_page()
        page.goto((PRIVATE/'candidate'/'capture.html').as_uri())
        page.wait_for_function('Boolean(window.gauntlet)')
        data=page.evaluate("""()=>{
          const g=window.gauntlet;
          function hold(key,ticks){
            g.key(key,true);g.advance(ticks);g.key(key,false);
            const {pose,hardContact,tip,massError}=window.sandLab.state();
            return {pose,hardContact,tip,massError};
          }
          g.reset();hold('KeyQ',44);hold('KeyF',13);hold('KeyD',135);
          const stop=hold('KeyS',140),pressed=hold('KeyS',20),withdrawn=hold('KeyW',16);
          return {stop,pressed,withdrawn};
        }""")
        browser.close()
    # Independently measure the same rendered poses against the carrier hull.
    probe="""import {carrierClearance} from './web/machine.js';import fs from 'node:fs';
      const d=JSON.parse(fs.readFileSync(0,'utf8'));
      console.log(JSON.stringify(Object.values(d).map(s=>carrierClearance(s.pose))));"""
    gaps=json.loads(subprocess.check_output(['node','--input-type=module','-e',probe],cwd=ROOT,input=json.dumps(data).encode()))
    print(json.dumps(dict(states=data,signedGapsMetres=gaps)))
    assert data['stop']['hardContact'] and data['pressed']['pose']==data['stop']['pose']
    assert not data['withdrawn']['hardContact'] and all(abs(v['massError'])==0 for v in data.values())
    assert -0.0001<gaps[0]<0.001 and gaps[2]>0.02, gaps
    save_json(PRIVATE/'carrier-stop.json',dict(states=data,signedGapsMetres=gaps))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['baseline','candidate','plates','gallery','contact'])
    command = parser.parse_args().command
    if command == 'contact':
        check_carrier_stop()
    elif command == 'gallery':
        export_gallery()
    elif command == 'plates':
        make_blind_set()
    else:
        record(command)
