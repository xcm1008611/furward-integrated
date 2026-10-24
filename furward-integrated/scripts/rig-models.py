#!/usr/bin/env python3
"""Add real glTF skins and joint animation, preserving source mesh/UV/texture bytes.

Requires Python 3 + numpy. Run from any directory. No Blender dependency.
The small original meshes are fitted with explicit anatomical landmarks; this is
deliberately not advertised as a general automatic-rigging algorithm.
"""
from pathlib import Path
import collections
import copy
import hashlib
import json
import math
import struct
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'web/public/city/animated'
SOURCE = ROOT / 'source-assets/city/assets'
I = np.array([0., 0., 0., 1.])
HUMAN_WALK_SWEEP = .68  # Foot's local fore/aft stance travel, not world step length.
HUMAN_WALK_BOB = -.044


def smooth(a, b, x):
    t = np.clip((x-a)/(b-a), 0., 1.)
    return t*t*(3-2*t)


def qmul(a, b):
    av, aw, bv, bw = a[:3], a[3], b[:3], b[3]
    return np.r_[aw*bv+bw*av+np.cross(av,bv), aw*bw-np.dot(av,bv)]


def qinv(q):
    return np.r_[-q[:3], q[3]]


def qaxis(axis, angle):
    v = np.asarray(axis, float)
    return np.r_[v/np.linalg.norm(v)*math.sin(angle/2), math.cos(angle/2)]


def qbetween(a, b):
    a, b = np.asarray(a,float), np.asarray(b,float)
    a, b = a/np.linalg.norm(a), b/np.linalg.norm(b)
    q = np.r_[np.cross(a,b), 1.+np.dot(a,b)]
    if np.linalg.norm(q) < 1e-8:
        return qaxis([1,0,0],math.pi)
    return q/np.linalg.norm(q)


def qmatrix(q):
    x,y,z,w = q
    return np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                     [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                     [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])


def ik(hip, knee_rest, ankle_rest, target, pole):
    """Two bone IK, length preserving, with an explicit knee bend direction."""
    upper = np.linalg.norm(knee_rest-hip)
    lower = np.linalg.norm(ankle_rest-knee_rest)
    delta = target-hip
    dist = min(np.linalg.norm(delta), upper+lower-1e-5)
    direct = delta/np.linalg.norm(delta)
    pole = np.asarray(pole,float)
    plane = pole-direct*np.dot(pole,direct)
    plane /= np.linalg.norm(plane)
    along = (upper*upper-lower*lower+dist*dist)/(2*dist)
    knee = hip + direct*along + plane*math.sqrt(max(0,upper*upper-along*along))
    ankle = hip + direct*dist
    return knee, ankle


class GLB:
    def __init__(self, path):
        self.source = path.read_bytes()
        length, kind = struct.unpack_from('<II',self.source,12)
        self.doc = json.loads(self.source[20:20+length])
        blen, bkind = struct.unpack_from('<II',self.source,20+length)
        self.binary = bytearray(self.source[28+length:28+length+blen])
        self.original_binary = bytes(self.binary)

    def array(self, index):
        a = self.doc['accessors'][index]
        v = self.doc['bufferViews'][a['bufferView']]
        dtype = np.dtype({5126:'<f4',5125:'<u4',5123:'<u2',5121:'u1'}[a['componentType']])
        width = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}[a['type']]
        return np.ndarray((a['count'],width),dtype,buffer=self.binary,
            offset=v.get('byteOffset',0)+a.get('byteOffset',0),
            strides=(v.get('byteStride',dtype.itemsize*width),dtype.itemsize)).copy()

    def append(self, data, typ, dtype='<f4', bounds=False, target=None):
        while len(self.binary)%4:
            self.binary.append(0)
        data = np.asarray(data,dtype=np.dtype(dtype))
        raw = data.tobytes()
        view = {'buffer':0,'byteOffset':len(self.binary),'byteLength':len(raw)}
        if target:
            view['target']=target
        self.binary.extend(raw)
        views = self.doc.setdefault('bufferViews',[])
        views.append(view)
        accessor = {'bufferView':len(views)-1,'componentType':5123 if dtype=='<u2' else 5126,
                    'count':len(data),'type':typ}
        if bounds:
            rows=data.reshape(len(data),-1)
            accessor.update(min=rows.min(0).tolist(), max=rows.max(0).tolist())
        acc = self.doc.setdefault('accessors',[])
        acc.append(accessor)
        return len(acc)-1

    def write(self,path):
        while len(self.binary)%4:
            self.binary.append(0)
        self.doc['buffers'][0]['byteLength']=len(self.binary)
        doc=json.dumps(self.doc,separators=(',',':')).encode()
        doc += b' ' * (-len(doc)%4)
        path.write_bytes(struct.pack('<4sII',b'glTF',2,28+len(doc)+len(self.binary))+
                         struct.pack('<II',len(doc),0x4e4f534a)+doc+
                         struct.pack('<II',len(self.binary),0x004e4942)+self.binary)


def connected(vertices, faces):
    welded, inv = np.unique(np.round(vertices,5),axis=0,return_inverse=True)
    parent=np.arange(len(welded))
    def root(i):
        while parent[i]!=i:
            parent[i]=parent[parent[i]]
            i=parent[i]
        return i
    for face in inv[faces]:
        for i in face[1:]:
            parent[root(i)]=root(face[0])
    groups=collections.defaultdict(list)
    for i in range(len(welded)):
        groups[root(i)].append(i)
    result=[]
    for ids in groups.values():
        result.append((np.where(np.isin(inv,ids))[0],welded[ids]))
    return result


class Rig:
    def __init__(self,kind,glb):
        self.kind,self.glb=kind,glb
        self.prim=glb.doc['meshes'][0]['primitives'][0]
        self.vertices=glb.array(self.prim['attributes']['POSITION']).astype(float)
        self.faces=glb.array(self.prim['indices']).reshape(-1,3)
        self.bones=[]
        self.lookup={}
        self.legs=[]
        self.weights=np.zeros((len(self.vertices),64),float)
        self.add('root',None,[0,0,0])

    def add(self,name,parent,pos):
        i=len(self.bones)
        self.bones.append({'name':name,'parent':self.lookup.get(parent),'pos':np.array(pos,float)})
        self.lookup[name]=i
        return i

    def weight(self,ids,weights):
        for name,value in weights.items():
            self.weights[ids,self.lookup[name]]=value

    def human(self):
        self.add('pelvis','root',[0,.90,0])
        self.add('spine','pelvis',[0,1.12,0])
        self.add('chest','spine',[0,1.36,0])
        self.add('neck','chest',[0,1.49,0])
        self.add('head','neck',[0,1.58,0])
        for side,s in [('L',1),('R',-1)]:
            self.add('upperarm_'+side,'chest',[s*.315,1.405,.005])
            self.add('forearm_'+side,'upperarm_'+side,[s*.395,1.105,.025])
            self.add('hand_'+side,'forearm_'+side,[s*.435,.87,.055])
            hip=np.array([s*.205,.875,0.])
            knee=np.array([s*.235,.47,.025])
            ankle=np.array([s*.255,.105,.025])
            self.add('thigh_'+side,'pelvis',hip)
            self.add('shin_'+side,'thigh_'+side,knee)
            self.add('foot_'+side,'shin_'+side,ankle)
            self.add('toe_'+side,'foot_'+side,[s*.255,.045,.17])
            ids=np.where((self.vertices[:,0]*s>0)&(self.vertices[:,1]<.13))[0]
            self.legs.append({'side':side,'upper':'thigh_'+side,'lower':'shin_'+side,
                'foot':'foot_'+side,'hip':hip,'knee':knee,'ankle':ankle,
                'floor':0.,'pole':[0,0,1],'phase':0 if side=='L' else .5,'sole_ids':ids})
        for i,(x,y,z) in enumerate(self.vertices):
            side='L' if x>0 else 'R'
            if .75<y<1.43 and abs(x)>(.29 if y>1.05 else .33):
                hand=1-smooth(.86,.94,y)
                upper=smooth(1.04,1.17,y)
                shoulder=smooth(1.33,1.44,y)*.25
                self.weight(i,{'hand_'+side:hand,'forearm_'+side:(1-hand)*(1-upper),
                    'upperarm_'+side:(1-hand)*upper*(1-shoulder),'chest':(1-hand)*upper*shoulder})
            elif y<.85:
                if y<.18:
                    foot=1-smooth(.12,.20,y)
                    self.weight(i,{'foot_'+side:foot,'shin_'+side:1-foot})
                else:
                    thigh=smooth(.40,.54,y)
                    pelvis=smooth(.73,.87,y)
                    self.weight(i,{'shin_'+side:1-thigh,'thigh_'+side:thigh*(1-pelvis),'pelvis':thigh*pelvis})
            elif y<1.16:
                spine=smooth(.91,1.16,y)
                self.weight(i,{'pelvis':1-spine,'spine':spine})
            elif y<1.47:
                chest=smooth(1.19,1.36,y)
                self.weight(i,{'spine':1-chest,'chest':chest})
            else:
                head=smooth(1.47,1.56,y)
                self.weight(i,{'neck':1-head,'head':head})

    def dog(self):
        self.add('body','root',[0,.61,0])
        self.add('head','body',[.10,.75,.16])
        for ids,pts in connected(self.vertices,self.faces):
            if pts[:,1].min()>.10:
                self.weight(ids,{'head' if pts[:,1].min()>.69 and pts[:,2].mean()>0 else 'body':1})
                continue
            side=('front_' if pts[:,2].mean()>0 else 'rear_')+('L' if pts[:,0].mean()>0 else 'R')
            top=pts[pts[:,1]>.53].mean(0)
            middle=pts[(pts[:,1]>.29)&(pts[:,1]<.46)].mean(0)
            ankle=pts[pts[:,1]<.13].mean(0)
            # The skin has only a few rings. Place the hinge through their centre.
            hip=np.array([top[0],top[1],top[2]])
            knee=np.array([middle[0],middle[1],middle[2]])
            self.add('upper_'+side,'body',hip)
            self.add('lower_'+side,'upper_'+side,knee)
            self.add('foot_'+side,'lower_'+side,ankle)
            self.legs.append({'side':side,'upper':'upper_'+side,'lower':'lower_'+side,
                'foot':'foot_'+side,'hip':hip,'knee':knee,'ankle':ankle,
                'floor':float(pts[:,1].min()),'pole':[0,0,-1],
                'phase':{'front_L':0.,'rear_R':.18,'front_R':.50,'rear_L':.68}[side],
                'sole_ids':ids[self.vertices[ids,1]<.13]})
            for i in ids:
                y=self.vertices[i,1]
                foot=1-smooth(.125,.18,y)
                upper=smooth(knee[1]-.035,knee[1]+.035,y)
                self.weight(i,{'foot_'+side:foot,'lower_'+side:(1-foot)*(1-upper),'upper_'+side:(1-foot)*upper})

    def pose(self,clip,t,duration):
        n=len(self.bones)
        translations=np.array([b['pos']-(self.bones[b['parent']]['pos'] if b['parent'] is not None else 0) for b in self.bones])
        rotations=np.tile(I,(n,1))
        human=self.kind=='human'
        moving=clip in ('walk','turn_left','turn_right','stop')
        cycle=1.20 if human else 1.12
        phase=t/cycle
        amplitude=1. if moving else 0.
        if clip=='stop':
            amplitude=1-smooth(0,duration,t)
            phase=t*.40/cycle
        turning=clip.startswith('turn_')
        stride=(HUMAN_WALK_SWEEP if human and clip=='walk' else .42 if human else .31)*(0.46 if turning else 1.)
        lift=.095 if human else .075
        bob=(HUMAN_WALK_BOB if human and clip=='walk' else -.040 if human else -.030)*amplitude
        bob += (.006 if human else .004)*amplitude*(1-math.cos(phase*4*math.pi))
        # Neutral dog pose is levelled through IK, without editing source vertices.
        if not human:
            bob -= .012
        translations[0,1]=bob
        for leg in self.legs:
            p=(phase+leg['phase'])%1
            stance=.62 if human else .70
            if p<stance:
                z=.5-p/stance
                y=0.
            else:
                s=(p-stance)/(1-stance)
                z=-.5+smooth(0,1,s)
                y=math.sin(math.pi*s)**1.3*lift
            factor=.78 if turning and ((clip=='turn_left')==leg['side'].endswith('L')) else 1.
            target=leg['ankle'].copy()
            target[1]-=leg['floor']
            if clip=='stop':
                # Settle feet in alternating small steps instead of dragging
                # both planted soles toward the idle position.
                first=(leg['side']=='R') if human else leg['side'] in ('front_R','rear_L')
                start=0. if first else duration*.5
                progress=float(np.clip((t-start)/(duration*.5),0,1))
                initial=.5-leg['phase']/stance
                target[1]+=math.sin(math.pi*progress)*(.042 if human else .030)
                target[2]+=initial*stride*(1-smooth(0,1,progress))
            else:
                target[1]+=y*amplitude
                target[2]+=z*stride*amplitude*factor
            foot_world=I.copy()
            if human and clip=='walk':
                # Roll from heel strike to toe-off using the existing shoe's
                # actual contact vertex. Rotating around the ankle without
                # compensating its XYZ target would float or slide the sole.
                if p<stance:
                    u=p/stance
                    pitch=math.radians(-22)*(1-smooth(0,.23,u))+math.radians(20)*smooth(.72,1,u)
                else:
                    u=(p-stance)/(1-stance)
                    pitch=math.radians(20)+(math.radians(-22)-math.radians(20))*smooth(0,1,u)
                foot_world=qaxis([1,0,0],pitch)
                original_sole=self.vertices[leg['sole_ids']]-leg['ankle']
                rolled=original_sole@qmatrix(foot_world).T
                contact=int(np.argmin(rolled[:,1]))
                target[1]+=-rolled[contact,1]-leg['ankle'][1]
                target[2]+=original_sole[contact,2]-rolled[contact,2]
            hip=leg['hip']+np.array([0,bob,0])
            rest_knee=leg['knee']+np.array([0,bob,0])
            rest_ankle=leg['ankle']+np.array([0,bob,0])
            knee,ankle=ik(hip,rest_knee,rest_ankle,target,leg['pole'])
            upper=qbetween(leg['knee']-leg['hip'],knee-hip)
            lower=qbetween(leg['ankle']-leg['knee'],ankle-knee)
            rotations[self.lookup[leg['upper']]]=upper
            rotations[self.lookup[leg['lower']]]=qmul(qinv(upper),lower)
            rotations[self.lookup[leg['foot']]]=qmul(qinv(lower),foot_world) if human and clip=='walk' else qinv(lower)
        if human:
            for side,s in [('L',1),('R',-1)]:
                angle=math.cos(phase*2*math.pi)*.20*s*amplitude
                rotations[self.lookup['upperarm_'+side]]=qaxis([1,0,0],angle)
                rotations[self.lookup['forearm_'+side]]=qaxis([1,0,0],-.05-.06*amplitude)
            rotations[self.lookup['chest']]=qaxis([0,1,0],math.sin(phase*2*math.pi)*.028*amplitude)
            rotations[self.lookup['head']]=qaxis([0,1,0],math.sin(t/duration*2*math.pi)*.012*(1-amplitude))
        else:
            rotations[self.lookup['head']]=qaxis([1,0,0],math.sin(t/duration*2*math.pi)*.012)
        return translations,rotations

    def skin_positions(self,translations,rotations):
        matrices=[]
        for i,b in enumerate(self.bones):
            mat=np.eye(4)
            mat[:3,:3]=qmatrix(rotations[i])
            mat[:3,3]=translations[i]
            if b['parent'] is not None:
                mat=matrices[b['parent']]@mat
            matrices.append(mat)
        result=np.zeros_like(self.vertices)
        for i,b in enumerate(self.bones):
            result += ((self.vertices-b['pos'])@matrices[i][:3,:3].T+matrices[i][:3,3])*self.weights[:,i,None]
        return result

    def export(self):
        (self.human if self.kind=='human' else self.dog)()
        count=len(self.bones)
        self.weights=self.weights[:,:count]
        assert np.allclose(self.weights.sum(1),1), 'Invalid weights'
        d=self.glb.doc
        original_nodes=len(d['nodes'])
        for i,b in enumerate(self.bones):
            parent=b['parent']
            node={'name':self.kind+'_'+b['name'],'translation':(b['pos']-(self.bones[parent]['pos'] if parent is not None else 0)).tolist()}
            children=[original_nodes+j for j,c in enumerate(self.bones) if c['parent']==i]
            if children:
                node['children']=children
            d['nodes'].append(node)
        d['nodes'][1]['children'].append(original_nodes)
        d['nodes'][0]['skin']=0
        for node in d['nodes'][:2]:
            node.setdefault('extras',{}).update(rigged=True,animation_type='skeletal',forward='glTF +Z')
        joints=np.argsort(-self.weights,axis=1)[:,:4]
        weights=np.take_along_axis(self.weights,joints,axis=1)
        weights/=weights.sum(1,keepdims=True)
        self.prim['attributes']['JOINTS_0']=self.glb.append(joints,'VEC4','<u2',target=34962)
        self.prim['attributes']['WEIGHTS_0']=self.glb.append(weights,'VEC4',target=34962)
        matrices=[]
        for b in self.bones:
            m=np.eye(4)
            m[:3,3]=-b['pos']
            matrices.append(m.T.reshape(16))
        bind=self.glb.append(matrices,'MAT4')
        d['skins']=[{'name':self.kind+'_skin','skeleton':original_nodes,'joints':list(range(original_nodes,original_nodes+count)),'inverseBindMatrices':bind}]
        d['animations']=[]
        clipinfo=[]
        metrics={}
        for clip,duration in [('idle',2.4),('walk',1.20 if self.kind=='human' else 1.12),('turn_left',1.20 if self.kind=='human' else 1.12),('turn_right',1.20 if self.kind=='human' else 1.12),('stop',.48)]:
            times=np.linspace(0,duration,round(duration*30)+1)
            poses=[self.pose(clip,t,duration) for t in times]
            # Looping clips must agree exactly at both ends, including breathing.
            if clip!='stop':
                poses[-1]=(poses[0][0].copy(),poses[0][1].copy())
            translations=np.array([p[0] for p in poses])
            rotations=np.array([p[1] for p in poses])
            for bone in range(count):
                for frame in range(1,len(times)):
                    if np.dot(rotations[frame-1,bone],rotations[frame,bone])<0:
                        rotations[frame,bone]*=-1
            timeacc=self.glb.append(times[:,None],'SCALAR',bounds=True)
            animation={'name':clip,'samplers':[],'channels':[]}
            def channel(bone,path,data):
                output=self.glb.append(data,'VEC3' if path=='translation' else 'VEC4')
                sampler=len(animation['samplers'])
                animation['samplers'].append({'input':timeacc,'output':output,'interpolation':'LINEAR'})
                animation['channels'].append({'sampler':sampler,'target':{'node':original_nodes+bone,'path':path}})
            channel(0,'translation',translations[:,0])
            for i in range(count):
                # Include constant rotations, so crossfades restore each joint.
                channel(i,'rotation',rotations[:,i])
            d['animations'].append(animation)
            verts=[self.skin_positions(*pose) for pose in poses]
            min_y=min(float(v[:,1].min()) for v in verts)
            max_step=max(float(v[leg['sole_ids'],1].min()) for v in verts for leg in self.legs)
            joint_motion=max(float(np.max(np.abs(rotations[:,i]-rotations[0,i]))) for i in range(count))
            metrics[clip]={'minimum_vertex_y_m':round(min_y,5),'max_foot_lift_m':round(max_step,5),
                'max_joint_quaternion_delta':round(joint_motion,5),'frames':len(times)}
            clipinfo.append({'name':clip,'duration_s':duration,'loop':clip!='stop'})
        d.setdefault('asset',{})['generator']='Furward explicit landmark skin rig 1.0; source visual bytes preserved'
        d.setdefault('extras',{})['furward']={'rigVersion':1,'inPlace':True,'forward':'+Z','units':'meters','up':'+Y','height':1.8 if self.kind=='human' else .9}
        output=OUT/(self.kind+'.glb')
        self.glb.write(output)
        assert bytes(self.glb.binary[:len(self.glb.original_binary)])==self.glb.original_binary
        return {'url':'/city/animated/'+output.name,'root':d['nodes'][1]['name'],
            'height_m':1.8 if self.kind=='human' else .9,'forward':'+Z','up':'+Y','units':'meters',
            'centered_xz':True,'feet_origin_y':0,'in_place':True,'bones':count,'skins':1,
            'source_mesh_unchanged':True,'source_uv_unchanged':True,'source_textures_unchanged':True,
            'source_binary_sha256':hashlib.sha256(self.glb.original_binary).hexdigest(),
            'output_sha256':hashlib.sha256(output.read_bytes()).hexdigest(),
            'vertices':len(self.vertices),'triangles':len(self.faces),'clips':clipinfo,
            'nominal_walk_speed_mps':HUMAN_WALK_SWEEP/(.62*1.20) if self.kind=='human' else .31/(.70*1.12),
            'gait':{'stride_m':HUMAN_WALK_SWEEP if self.kind=='human' else .31,
                'cycle_s':1.20 if self.kind=='human' else 1.12,'stance_fraction':.62 if self.kind=='human' else .70,
                **({'stride_definition':'local foot travel during stance; world step length is stride / stance_fraction / 2',
                    'foot_roll_degrees':[-22,20], 'walk_body_offset_m':HUMAN_WALK_BOB,
                    'steps_per_minute_at_1_2mps':120*.62*1.2/HUMAN_WALK_SWEEP} if self.kind=='human' else {})},
            'metrics':metrics,'joints':[b['name'] for b in self.bones]}


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    manifest={'version':1,'coordinate_system':'glTF Y-up; meters; forward +Z',
        'placement':'Position the original character root; no centering/scaling or extra axis conversion.',
        'movement':'All clips are in-place. Route controller owns translation and yaw. Use AnimationMixer crossfades.',
        'quality':'Demo skeletal gait; not motion capture or robot dynamics. Original textures and topology retained.',
        'models':{}}
    for kind,source in [('human','blind_person.glb'),('dog','robot_dog.glb')]:
        result=Rig(kind,GLB(SOURCE/source)).export()
        manifest['models'][kind]=result
        print(kind,json.dumps({'bones':result['bones'],'metrics':result['metrics']},ensure_ascii=False))
    (OUT/'rig-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':
    main()
