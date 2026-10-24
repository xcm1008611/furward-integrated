#!/usr/bin/env python3
"""Validate the written GLBs, including interpolated skin deformation at 60 Hz.

This reads exported buffers independently of the authoring rig and verifies
texture/mesh preservation, bind matrices, loops, feet, and actual limb motion.
"""
from pathlib import Path
import hashlib
import json
import math
import struct
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'web/public/city/animated'

class File:
    def __init__(self,path):
        raw=path.read_bytes()
        magic,version,total=struct.unpack_from('<4sII',raw)
        assert magic==b'glTF' and version==2 and total==len(raw)
        size,kind=struct.unpack_from('<II',raw,12)
        self.d=json.loads(raw[20:20+size])
        bsize,bkind=struct.unpack_from('<II',raw,20+size)
        self.binary=raw[28+size:28+size+bsize]
    def array(self,i):
        a=self.d['accessors'][i];v=self.d['bufferViews'][a['bufferView']]
        dtype=np.dtype({5126:'<f4',5123:'<u2',5125:'<u4',5121:'u1'}[a['componentType']])
        width={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}[a['type']]
        return np.ndarray((a['count'],width),dtype,buffer=self.binary,
            offset=v.get('byteOffset',0)+a.get('byteOffset',0),
            strides=(v.get('byteStride',width*dtype.itemsize),dtype.itemsize)).copy()

def rot(q):
    x,y,z,w=q
    return np.array([[1-2*y*y-2*z*z,2*x*y-2*z*w,2*x*z+2*y*w],
        [2*x*y+2*z*w,1-2*x*x-2*z*z,2*y*z-2*x*w],
        [2*x*z-2*y*w,2*y*z+2*x*w,1-2*x*x-2*y*y]])

def slerp(a,b,t):
    dot=float(np.dot(a,b))
    if dot<0:b=-b;dot=-dot
    if dot>.9995:
        q=a+(b-a)*t
        return q/np.linalg.norm(q)
    theta=math.acos(np.clip(dot,-1,1))
    return (a*math.sin((1-t)*theta)+b*math.sin(t*theta))/math.sin(theta)

def run(kind,source):
    old=File(ROOT/'source-assets/city/assets'/source)
    new=File(OUT/(kind+'.glb'))
    d=new.d
    assert new.binary[:len(old.binary)]==old.binary,'Original mesh/texture buffer changed'
    for key in ('images','textures','materials','samplers'):
        assert d.get(key)==old.d.get(key),key+' changed'
    p=d['meshes'][0]['primitives'][0]
    p0=old.d['meshes'][0]['primitives'][0]
    for name,index in p0['attributes'].items():
        assert np.array_equal(old.array(index),new.array(p['attributes'][name])),name+' changed'
    assert np.array_equal(old.array(p0['indices']),new.array(p['indices']))
    vertices=new.array(p['attributes']['POSITION']).astype(float)
    joints=new.array(p['attributes']['JOINTS_0']).astype(int)
    weights=new.array(p['attributes']['WEIGHTS_0']).astype(float)
    assert np.isfinite(weights).all() and weights.min()>=0 and np.allclose(weights.sum(1),1,atol=1e-6)
    assert len(d['skins'])==1
    skin=d['skins'][0]
    assert joints.max()<len(skin['joints'])
    ibm=new.array(skin['inverseBindMatrices']).reshape(-1,4,4).transpose(0,2,1).astype(float)
    parents={c:i for i,n in enumerate(d['nodes']) for c in n.get('children',[])}
    def sample(anim,t):
        trans={i:np.array(n.get('translation',[0,0,0]),float) for i,n in enumerate(d['nodes'])}
        quats={i:np.array(n.get('rotation',[0,0,0,1]),float) for i,n in enumerate(d['nodes'])}
        if anim:
            for channel in anim['channels']:
                sampler=anim['samplers'][channel['sampler']]
                times=new.array(sampler['input']).ravel()
                values=new.array(sampler['output']).astype(float)
                k=max(0,min(int(np.searchsorted(times,t,side='right')-1),len(times)-2))
                alpha=np.clip((t-times[k])/(times[k+1]-times[k]),0,1)
                path=channel['target']['path'];node=channel['target']['node']
                if path=='rotation':quats[node]=slerp(values[k],values[k+1],alpha)
                else:trans[node]=values[k]+(values[k+1]-values[k])*alpha
        world={}
        def matrix(i):
            if i not in world:
                m=np.eye(4);m[:3,:3]=rot(quats[i]);m[:3,3]=trans[i]
                world[i]=matrix(parents[i])@m if i in parents else m
            return world[i]
        mats=np.stack([matrix(node)@ibm[j] for j,node in enumerate(skin['joints'])])
        v4=np.c_[vertices,np.ones(len(vertices))]
        result=np.zeros((len(vertices),4))
        for slot in range(4):
            result+=np.einsum('nij,nj->ni',mats[joints[:,slot]],v4)*weights[:,slot,None]
        return result[:,:3]
    assert np.allclose(sample(None,0),vertices,atol=2e-6),'Bind pose changes shape'
    assert {a['name'] for a in d['animations']}=={'idle','walk','turn_left','turn_right','stop'}
    report={}
    for anim in d['animations']:
        name=anim['name']
        duration=max(float(new.array(s['input']).max()) for s in anim['samplers'])
        for channel in anim['channels']:
            vals=new.array(anim['samplers'][channel['sampler']]['output'])
            assert np.isfinite(vals).all()
            if channel['target']['path']=='translation':
                assert np.allclose(vals[:,[0,2]],0),name+' contains root horizontal motion'
            else:assert np.allclose(np.linalg.norm(vals,axis=1),1,atol=1e-5)
        samples=[sample(anim,t) for t in np.linspace(0,duration,math.ceil(duration*60)+1)]
        minimum=min(float(v[:,1].min()) for v in samples)
        assert minimum>-.004,f'{kind} {name}: penetrates ground {minimum}'
        motion=max(float(np.linalg.norm(v-samples[0],axis=1).max()) for v in samples)
        if name!='stop':assert np.allclose(samples[0],samples[-1],atol=2e-5),'Loop discontinuity'
        if name in ('walk','turn_left','turn_right'):assert motion>.07,'No meaningful limb motion'
        sole_motion={}
        for j,node in enumerate(skin['joints']):
            if '_foot_' not in d['nodes'][node]['name']:continue
            mask=np.any((joints==j)&(weights>.99),axis=1)
            ys=[float(v[mask,1].min()) for v in samples]
            sole_motion[d['nodes'][node]['name']]={'min_y_m':round(min(ys),5),'max_y_m':round(max(ys),5)}
        report[name]={'duration_s':round(duration,4),'samples_at_60hz':len(samples),
            'min_vertex_y_m':round(minimum,6),'max_vertex_motion_m':round(motion,4),'feet':sole_motion}
    idle=next(a for a in d['animations'] if a['name']=='idle')
    stop=next(a for a in d['animations'] if a['name']=='stop')
    assert np.allclose(sample(idle,0),sample(stop,.48),atol=3e-5),'Stop does not settle into idle'
    return {'status':'passed','mesh_uv_normals_indices_and_textures_byte_preserved':True,
        'bind_pose_matches_source':True,'skin_count':len(d['skins']),'bone_count':len(skin['joints']),
        'sha256':hashlib.sha256((OUT/(kind+'.glb')).read_bytes()).hexdigest(),'clips':report}

if __name__=='__main__':
    result={'status':'passed','method':'independent exported-GLB parse + CPU skinning at 60 Hz; browser visual QA is separate',
        'models':{kind:run(kind,source) for kind,source in [('human','blind_person.glb'),('dog','robot_dog.glb')]}}
    (OUT/'validation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2))
