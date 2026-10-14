import * as THREE from 'three';

const C={bg:0x050d17,metal:0x526475,dark:0x111e2b,deep:0x0a111b,cyan:0x66edf1,ice:0xc0fdff,amber:0xffb26e,green:0x244f43,purple:0xb4a3ec};
const rand=(a,b)=>a+Math.random()*(b-a);
const seedRand=(()=>{let state=17834;return()=>{state=(1664525*state+1013904223)>>>0;return state/4294967296}})();
const rr=(a,b)=>a+(b-a)*seedRand();
const V=(x,y,z)=>new THREE.Vector3(x,y,z);

function material(color,metalness=.3,roughness=.5,emissive=0,emissiveIntensity=0){return new THREE.MeshStandardMaterial({color,metalness,roughness,emissive,emissiveIntensity});}
function solid(g,w,h,d,x,y,z,mat){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);m.position.set(x,y,z);g.add(m);return m;}
function orb(g,r,x,y,z,mat,segments=12){let m=new THREE.Mesh(new THREE.SphereGeometry(r,segments,8),mat);m.position.set(x,y,z);g.add(m);return m;}
function cyl(g,r1,r2,len,x,y,z,mat,along='y',seg=24){const m=new THREE.Mesh(new THREE.CylinderGeometry(r1,r2,len,seg),mat);if(along==='x')m.rotation.z=Math.PI/2;else if(along==='z')m.rotation.x=Math.PI/2;m.position.set(x,y,z);g.add(m);return m;}
function line(g,pts,col,r=.055,op=1){let curve=new THREE.CatmullRomCurve3(pts.map(p=>new THREE.Vector3(...p)),false,'centripetal');let m=new THREE.Mesh(new THREE.TubeGeometry(curve,Math.max(3,pts.length*8),r,6,false),new THREE.MeshBasicMaterial({color:col,transparent:op<1,opacity:op}));g.add(m);return m;}
function beam(g,from,to,color=C.cyan,r=.13){const a=V(...from),b=V(...to),center=a.clone().add(b).multiplyScalar(.5),dist=a.distanceTo(b),normal=b.clone().sub(a).normalize();const group=new THREE.Group();group.position.copy(center);group.quaternion.setFromUnitVectors(V(0,1,0),normal);let core=cyl(group,r,r,dist,0,0,0,new THREE.MeshBasicMaterial({color,transparent:true,opacity:.92,depthWrite:false}));const aura=cyl(group,r*6,r*6,dist,0,0,0,new THREE.MeshBasicMaterial({color,transparent:true,opacity:.055,blending:THREE.AdditiveBlending,depthWrite:false}), 'y',16);group.userData.runtimeEffect=true;g.add(group);return {group,core,aura};}
function particles(g,count,spread,pos,col=C.cyan,r=.06){const geom=new THREE.BufferGeometry(),v=new Float32Array(count*3);for(let i=0;i<count;i++){v[i*3]=pos[0]+rr(-spread[0],spread[0]);v[i*3+1]=pos[1]+rr(-spread[1],spread[1]);v[i*3+2]=pos[2]+rr(-spread[2],spread[2]);}geom.setAttribute('position',new THREE.BufferAttribute(v,3));const m=new THREE.Points(geom,new THREE.PointsMaterial({size:r,color:col,transparent:true,opacity:.64,depthWrite:false,sizeAttenuation:true,blending:THREE.AdditiveBlending}));m.userData.runtimeEffect=true;g.add(m);return m;}
function glowTexture(){const c=document.createElement('canvas');c.width=c.height=128;const ctx=c.getContext('2d');const gr=ctx.createRadialGradient(64,64,0,64,64,64);gr.addColorStop(0,'rgba(255,255,255,1)');gr.addColorStop(.12,'rgba(225,255,255,.95)');gr.addColorStop(.29,'rgba(119,247,255,.30)');gr.addColorStop(1,'rgba(70,190,255,0)');ctx.fillStyle=gr;ctx.fillRect(0,0,128,128);return new THREE.CanvasTexture(c);}
const glowMap=glowTexture();
function flare(g,x,y,z,color=C.cyan,size=4){const mat=new THREE.SpriteMaterial({map:glowMap,color,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,opacity:.7});const s=new THREE.Sprite(mat);s.position.set(x,y,z);s.scale.set(size,size,1);s.userData.runtimeEffect=true;g.add(s);return s;}
function floor(g,cx,cz,width,depth,colors=0x17222a){let f=new THREE.Mesh(new THREE.PlaneGeometry(width,depth),material(colors,.35,.78));f.rotation.x=-Math.PI/2;f.position.set(cx,-.22,cz);g.add(f);return f;}
function grid(g,cx,cz,w,d,step=4,ink=0x2b3b48){const ar=[];for(let x=-w/2;x<=w/2+.01;x+=step)ar.push(cx+x,0,cz-d/2,cx+x,0,cz+d/2);for(let z=-d/2;z<=d/2+.01;z+=step)ar.push(cx-w/2,0,cz+z,cx+w/2,0,cz+z);const geom=new THREE.BufferGeometry();geom.setAttribute('position',new THREE.Float32BufferAttribute(ar,3));const lines=new THREE.LineSegments(geom,new THREE.LineBasicMaterial({color:ink,transparent:true,opacity:.38}));g.add(lines);}
function makeExterior(){const g=new THREE.Group();g.name='Exterior / nighttime AI campus';floor(g,0,0,255,255,0x080f17);
 // Site roads, islands, curbs, trees and lights.
 const asphalt=material(0x151c24,.15,.94), curb=material(0x405161,.24,.65), lit=material(0x71deed,.2,.7,0x5edff2,2), roof=material(0x101820,.55,.75),wall=material(0x242f3b,.4,.67),window=material(0x1a3948,.2,.3,0x2c91ab,.9);
 // Three adjoining (rather than overlapping) asphalt slabs. The old side roads
 // coincided with the main lot at almost the same Y level (0.005 separation),
 // generating the most obvious long-range z-fighting in the exterior flythrough.
 solid(g,100,.06,190,0,.02,53,asphalt);        // lot: z -42..148, x -50..50
 solid(g,125,.06,25,0,.025,-54.5,asphalt);    // approach: z -67..-42
 solid(g,19,.06,102,-60,.025,9,asphalt);     // west lane: x -69.5..-50.5
 solid(g,19,.06,102,60,.025,9,asphalt);      // east lane: x 50.5..69.5
 // Footprint, layered rooftop and strip lighting.
 solid(g,78,9.6,57,0,4.7,0,wall);solid(g,80,.8,59,0,9.8,0,roof);solid(g,74,.5,52,0,10.2,0,material(0x18232c,.5,.6));
 for(let i=0;i<4;i++){solid(g,72,.12,.10,0,2.5+i*1.6,28.58,lit);solid(g,72,.12,.10,0,2.5+i*1.6,-28.58,lit);solid(g,.1,.12,55,-39.1,2.5+i*1.6,0,lit);solid(g,.1,.12,55,39.1,2.5+i*1.6,0,lit);}
 for(let i=0;i<32;i++){let x=-35+i*2.25;solid(g,1.4,2.4,.17,x,5,28.8,window);solid(g,1.4,2.4,.17,x,5,-28.8,window);}
 for(let i=0;i<23;i++){let z=-26+i*2.35;solid(g,.18,2.6,1.4,-39.2,5,z,window);solid(g,.18,2.6,1.4,39.2,5,z,window);}
 // Cooling plant on roof.
 for(let row=0;row<4;row++)for(let i=0;i<9;i++){let x=-31+i*7.5,z=-19+row*12;solid(g,5.2,1.3,7,x,11.1,z,material(0x283640,.55,.7));let fan=cyl(g,1.3,1.3,.1,x,11.82,z,material(0x0a141b,.4,.8));for(let k=0;k<4;k++){let a=k*Math.PI/2;solid(g,1.8,.05,.3,x+Math.cos(a)*.35,11.93,z+Math.sin(a)*.35,material(0x637584,.6,.4)).rotation.y=a;}}
 for(let i=0;i<18;i++){let x=-37+i*4.4;solid(g,1.6,.06,.23,x,0.09,-48,curb);solid(g,1.5,.06,.23,x,0.09,48,curb);}
 for(let i=0;i<24;i++){let z=-54+i*4.6;solid(g,.18,.06,1.5,-53,.1,z,curb);solid(g,.18,.06,1.5,53,.1,z,curb);}
 for(let j=0;j<58;j++){let x=rr(-78,78),z=rr(-85,85);if(Math.abs(x)<45&&Math.abs(z)<35)continue;const trunk=material(0x2a3028,.1,.9);cyl(g,.12,.18,1.2,x,.6,z,trunk);let pine=new THREE.Mesh(new THREE.ConeGeometry(rr(.7,1.5),rr(2.1,3.4),6),material(0x142e2d,.2,.94));pine.position.set(x,2.3,z);g.add(pine);}
 for(let i=0;i<32;i++){let z=-72+i*4.7,x=(i%2===0?56:-56);cyl(g,.08,.08,4.1,x,2.1,z,curb);orb(g,.33,x,4.4,z,new THREE.MeshBasicMaterial({color:0xcceffd}),8);flare(g,x,4.4,z,0x9bcaff,2.3);}
 // Distant skyline and city bokeh.
 for(let i=0;i<115;i++){let x=rr(-135,135),z=rr(-150,150);if(Math.abs(x)<90&&Math.abs(z)<90)continue;let h=rr(2,14);solid(g,rr(3,10),h,rr(3,10),x,h/2,z,material(0x0b141c,.1,1));if(i%2===0)flare(g,x,h+1,z,i%3?0x88bce1:0xe0ad6d,rr(.4,1.2));}
 particles(g,530,[130,34,130],[0,12,0],0x9fc1db,.20);return g;}

function makeHall(){const g=new THREE.Group();g.name='Interior / power and server racks';g.position.x=180;floor(g,0,0,53,96,0x273440);grid(g,0,0,53,96,3,0x5c6c78);const steel=material(0x53616e,.5,.65),black=material(0x101820,.72,.38),slot=material(0x1d2b37,.62,.48),cool=material(0x3f6773,.35,.43,0x2e94b1,.7),white=material(0xd0e1e8,.3,.45,0xc5f9ff,.7);
 // Server face details share four GPU instanced meshes rather than ~1,300 draw calls.
 const bladeCount=16*2*10,plates=new THREE.InstancedMesh(new THREE.BoxGeometry(5.13,.51,.045),slot,bladeCount),stripes=new THREE.InstancedMesh(new THREE.BoxGeometry(3.2,.055,.065),cool,bladeCount),ledGreen=new THREE.InstancedMesh(new THREE.SphereGeometry(.05,6,4),new THREE.MeshBasicMaterial({color:0x7cfef1}),bladeCount),ledAmber=new THREE.InstancedMesh(new THREE.SphereGeometry(.05,6,4),new THREE.MeshBasicMaterial({color:0xffa660}),bladeCount);const instanceMatrix=new THREE.Matrix4(),unitScale=new THREE.Vector3(1,1,1),identityQuaternion=new THREE.Quaternion();let detailIndex=0;const instanceAt=(mesh,index,x,y,z)=>{instanceMatrix.compose(V(x,y,z),identityQuaternion,unitScale);mesh.setMatrixAt(index,instanceMatrix);};
 for(let s of [-1,1]){solid(g,.4,14,97,25.8,7.0,0,steel);solid(g,.4,14,97,-25.8,7.0,0,steel);for(let i=0;i<10;i++){let z=-42+i*9.1;solid(g,51,.26,.35,0,14.1,z,steel);solid(g,51,.08,.35,0,13.65,z,white);}break;}
 solid(g,53,.7,96,0,14.6,0,material(0x1b2b35,.4,.84));
 for(let i=0;i<16;i++){let z=-44+i*6;for(let s of [-1,1]){let x=s*10.6;solid(g,5.7,9.6,4.45,x,4.8,z,black);// Collar overhang in both X and Z so no collar face lies on a rack face.
 solid(g,5.85,.22,4.60,x,9.55,z,steel);solid(g,5.85,.22,4.60,x,.20,z,steel);for(let q=0;q<10;q++){let yy=.75+q*.77;instanceAt(plates,detailIndex,x,yy,z+2.23);instanceAt(stripes,detailIndex,x-.7,yy,z+2.27);instanceAt(ledGreen,detailIndex,x+2,yy,z+2.29);instanceAt(ledAmber,detailIndex,x+1.75,yy,z+2.29);detailIndex++;}
 // Pull side trim 0.07 beyond rack side faces, rather than exactly flush.
 solid(g,.16,9.3,4.2,x-2.84,4.8,z,steel);solid(g,.16,9.3,4.2,x+2.84,4.8,z,steel);}}
 for(let mesh of [plates,stripes,ledGreen,ledAmber]){mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();g.add(mesh);}
 // Distributed power rails and orthogonal fiber traces suspended over racks.
 for(let i=0;i<6;i++){let z=34-i*12;const y=10.4+i%2*.4;line(g,[[-21,y,z],[-16,y,z],[-16,11.5,z-4],[17,11.5,z-4],[17,y,z-6],[21,y,z-6]],i%2?C.cyan:C.amber,.09);line(g,[[-21,y-.15,z],[-16,y-.15,z],[-16,11.35,z-4],[17,11.35,z-4],[17,y-.15,z-6]],i%2?0x2c8597:0xbd6630,.17,.2);}
 for(let s of [-1,1]){for(let z=-33;z<40;z+=15){line(g,[[s*15,10,z],[s*15,6,z],[s*12.5,6,z-2],[s*12.5,4,z-2]],s>0?C.cyan:C.amber,.1);}}
 for(let i=0;i<11;i++){let z=-42+i*8;solid(g,8,3.2,3,-20,1.6,z,steel);solid(g,8,3.2,3,20,1.6,z,steel);}
 flare(g,-16,10,9,C.amber,5);flare(g,17,11,-14,C.cyan,5);particles(g,360,[23,7,45],[0,7,0],0xcdf6ff,.14);return g;}

function makePCB(){const g=new THREE.Group();g.position.set(360,0,0);g.name='GaN / board macro';const green=material(0x244e3b,.2,.58),gold=new THREE.MeshBasicMaterial({color:0xd2a269}),die=material(0x1a2630,.54,.35),silver=material(0x8999a4,.75,.32),black=material(0x181f26,.42,.47);solid(g,26,14,.7,0,6,0,green);solid(g,26.35,.27,1.0,0,-.85,0,material(0x15261e,.35,.8));for(let x of [-12,12])for(let y of [0.1,11.9]){cyl(g,.47,.47,.1,x,y,.42,silver,'z');cyl(g,.23,.23,.13,x,y,.51,black,'z');}
 // thin printed traces
 for(let i=0;i<110;i++){let x=rr(-12,12),y=rr(.3,11.7),endX=x+rr(-4,4),endY=y+rr(-2,2);line(g,[[x,y,.39],[endX,y,.4],[endX,endY,.4]],i%9===0?0xe5aa51:0x679e7a,.015,i%9===0?.9:.6);}
 for(let i=0;i<55;i++){let x=rr(-11.5,11.5),y=rr(.6,11.3);const m=solid(g,rr(.15,.48),rr(.2,.7),rr(.3,.9),x,y,.75,i%6===0?silver:black);m.rotation.z=rr(-.05,.05);}
 // Large central GaN chip and metallic cooler
 solid(g,4.0,3.7,.8,.4,5.5,1.07,die);solid(g,3.45,3.15,.13,.4,5.5,1.54,material(0x243a3c,.5,.33,0x0e625f,.4));for(let i=0;i<8;i++){solid(g,.20,2.7,.23,-.96+i*.38,5.5,1.7,gold);}
 // Equally spaced component rows: randomly aligned coplanar modules used to intersect.
 for(let i=0;i<13;i++){const y=2.1+i*.63;solid(g,.85,.44,.72,-9.2+rr(-1,1),y,.83,black);solid(g,.8,.44,.72,8.7+rr(-1,1),y,.83,black);}
 for(let i=0;i<9;i++){let x=4.0+i*.47;solid(g,.20,5.5,1.9,x,7.3,1.15,silver);}
 for(let i=0;i<6;i++){cyl(g,.58,.58,1.0,-6.9+i*2.2,9,.9,material(0x6c7374,.7,.33),'z');}
 for(let i=0;i<5;i++){solid(g,.7,1.1,.6,-10.6+i*1.4,1.9,.85,material(0xc3d6cf,.1,.5));}
 // Upper board and ports
 solid(g,1.9,2.8,1.4,-11,5,1.4,material(0xd1dbd5,.1,.5));solid(g,1.9,2.8,1.4,11,5,1.4,material(0xd1dbd5,.1,.5));
 line(g,[[-13.2,6,2.0],[-17.5,7,2.0],[-20.2,7.3,3.5]],C.amber,.2);line(g,[[13.2,6,2.0],[17.5,7,2.0],[20.2,7.3,3.5]],C.cyan,.2);flare(g,.4,5.5,2.0,0x81fff1,5);particles(g,220,[17,9,8],[0,6,0],0xa3e7c8,.10);return g;}

function connection(g,a,b,color,r=.07){let center=a.clone().add(b).multiplyScalar(.5),dif=b.clone().sub(a),m=new THREE.Mesh(new THREE.CylinderGeometry(r,r,dif.length(),8),new THREE.MeshStandardMaterial({color,metalness:.65,roughness:.34}));m.position.copy(center);m.quaternion.setFromUnitVectors(V(0,1,0),dif.normalize());g.add(m);}
function makeAtoms(){const g=new THREE.Group();g.position.set(440,0,0);g.name='GaCl3 / crystalline structure';const lattice=new THREE.Group();lattice.name='lattice_spin';lattice.position.y=5.9;g.add(lattice);const grey=material(0x8e9daa,.8,.27),amber=material(0xffab61,.28,.28,0xe37c35,.9),lighter=material(0x668895,.7,.29);
 const atoms=[];for(let x=-4;x<=4;x++)for(let y=-3;y<=3;y++)for(let z=-2;z<=2;z++){if((x+y+z)%2===0){let px=x*1.18,py=y*1.1,pz=z*1.18,hot=(Math.abs(x+y+z)%5===0),pos=V(px,py,pz);atoms.push({x,y,z,pos});orb(lattice,hot?.32:.23,px,py,pz,hot?amber:grey,11);if(hot)flare(lattice,px,py,pz,C.amber,1.7);}}
 const mp=new Map(atoms.map(a=>[`${a.x},${a.y},${a.z}`,a]));for(let a of atoms){for(let d of [[1,1,0],[1,0,1],[0,1,1]]){let key=`${a.x+d[0]},${a.y+d[1]},${a.z+d[2]}`,b=mp.get(key);if(b)connection(lattice,a.pos,b.pos,(a.x+a.y)%3?0x778a98:0xe9a06c,.057);}}
 // free-standing reagent crystal stylization
 const crystalMat=new THREE.MeshPhysicalMaterial({color:0xd7eef0,metalness:.1,roughness:.15,transmission:.65,thickness:1.2,transparent:true,opacity:.74,depthWrite:false});for(let i=0;i<25;i++){const h=rr(.9,4),r=rr(.25,.9),geo=new THREE.CylinderGeometry(r*.65,r,h,6),m=new THREE.Mesh(geo,crystalMat);m.position.set(rr(-11,-7),h*.4+rr(2,4),rr(-1.5,2));m.rotation.z=rr(-1,1);g.add(m);}const plinth=solid(g,12,.2,7,-9,1.5,0,material(0x243d49,.5,.4));particles(g,360,[16,10,10],[0,6,0],0xe0b68d,.14);return {group:g,spin:lattice};}

function makeLaser(){const g=new THREE.Group();g.position.set(560,0,0);g.name='Indium phosphide laser source';floor(g,0,0,82,37,0x182531);grid(g,0,0,82,37,4,0x344c59);const shell=material(0x596d7d,.7,.28),dark=material(0x111c26,.8,.25),gold=material(0xe0a66e,.77,.35),copper=material(0x9f6b47,.75,.4),glass=new THREE.MeshPhysicalMaterial({color:0xb9f6ff,transparent:true,opacity:.21,roughness:.08,metalness:.03,transmission:.65,thickness:.8,depthWrite:false,side:THREE.DoubleSide});
 // laser device housing and optical bench
 solid(g,65,.6,11,0,.7,0,material(0x202e38,.5,.45));solid(g,17,9,8,-23,5.2,0,shell);solid(g,15,7,8,-23,5.1,4.0,dark);for(let j=0;j<10;j++){solid(g,11,.17,.18,-23,2.0+j*.62,8.07,shell);}
 solid(g,5,4,7,-11,5,0,gold);cyl(g,2.3,2.3,5,-8,5,0,shell,'x');cyl(g,1.6,1.6,5,-4,5,0,glass,'x');cyl(g,2.5,2.5,.55,-.5,5,0,shell,'x');
 // Intermediate receptacle and laser mount with semiconductor wafer
 solid(g,11,7,9,8,5,0,material(0x2a404e,.72,.25));solid(g,4,4,9.2,11.8,5,0,gold);solid(g,3.1,3.1,1.8,13.5,5,0,material(0x8fb3a3,.6,.3));cyl(g,2.0,2.0,6,22,5,0,shell,'x');cyl(g,1.2,1.2,6,25,5,0,glass,'x');cyl(g,2.4,2.4,.45,28,5,0,shell,'x');
 // Atom ring pattern on semiconductor
 const orbitMat=material(0x7af2fc,.1,.45,0x24adc0,.45);for(let i=0;i<24;i++){let a=2*Math.PI*i/24,x=4+Math.cos(a)*4.3,y=5+Math.sin(a)*3.6,z=4.8;orb(g,.24,x,y,z,orbitMat);if(i%3===0)flare(g,x,y,z,0x80fcff,1.5);}for(let row=0;row<3;row++)for(let col=0;col<5;col++){orb(g,.33,4+col*1.7,2.7+row*1.8,5.6,orbitMat,14);}
 const light=beam(g,[-36,5,0],[39,5,0],0x8efcff,.10);flare(g,-2,5,0,0x93fcff,8);flare(g,13,5,0,0xffbc95,6);flare(g,29,5,0,0x86fff3,7);particles(g,320,[39,12,17],[0,6,0],0x9cecf4,.12);return {group:g,beam:light};}

function makeFiber(){const g=new THREE.Group();g.position.set(690,0,0);g.name='Ge-doped silica optical fiber';floor(g,0,0,95,40,0x13222f);const glass=new THREE.MeshPhysicalMaterial({color:0xb8eaff,transparent:true,opacity:.20,roughness:.04,metalness:0,transmission:.74,thickness:1.4,depthWrite:false,side:THREE.DoubleSide});const silver=material(0x8ba2b7,.65,.25),core=material(0x5be9f2,.1,.22,0x21dce8,1.3),coating=new THREE.MeshPhysicalMaterial({color:0x556f84,transparent:true,opacity:.42,metalness:.4,roughness:.18,depthWrite:false,side:THREE.DoubleSide});
 // long translucent fiber barrel, annular end faces, neon core and particles
 // Explicit painter order for concentric transparent barrels. Core remains opaque.
 const fiberJacket=cyl(g,4.9,4.9,72,0,6,0,coating,'x',48);fiberJacket.renderOrder=1;
 const fiberCladding=cyl(g,4.6,4.6,70,0,6,0,glass,'x',48);fiberCladding.renderOrder=2;
 cyl(g,1.4,1.4,72,0,6,0,core,'x',36);
 for(let x of [-35.8,35.8]){cyl(g,5.0,5.0,.6,x,6,0,silver,'x',48);const innerCap=cyl(g,3.5,3.5,.8,x+(x>0?.45:-.45),6,0,glass,'x',48);innerCap.renderOrder=3;cyl(g,1.3,1.3,1.0,x+(x>0?.5:-.5),6,0,core,'x',36);}
 // Ring-shaped transverse atoms around fiber core
 for(let j=0;j<10;j++){let x=-29+j*6.0;for(let i=0;i<9;i++){let a=2*Math.PI*i/9;orb(g,.27,x,6+Math.cos(a)*2.75,Math.sin(a)*2.75,material(i%3===0?0x93f7ff:0x57798c,.5,.35,i%3===0?0x1ac3d9:0,.6),10);} }
 const light=beam(g,[-47,6,0],[47,6,0],0x9fffff,.11);for(let j=0;j<8;j++){const x=-32+j*9;flare(g,x,6,0,0x8ffcff,5.5);}
 particles(g,390,[47,13,23],[0,7,0],0x77e4eb,.12);return {group:g,beam:light};}

function makeOptics(){const g=new THREE.Group();g.position.set(815,0,0);g.name='Garnet substrate / optical isolator';floor(g,0,0,70,34,0x1a2531);grid(g,0,0,70,34,4,0x314451);const metal=material(0x9cacc1,.79,.24),dark=material(0x29394b,.62,.35),glass=new THREE.MeshPhysicalMaterial({color:0xb6f4ff,transparent:true,opacity:.22,metalness:.1,roughness:.08,transmission:.73,thickness:1.3,depthWrite:false,side:THREE.DoubleSide});
 solid(g,48,.75,11,0,1,0,metal);for(let i=0;i<5;i++){let x=-15+i*8;cyl(g,4.0,4.0,.7,x,5,0,metal,'x',40);cyl(g,3.1,3.1,1.4,x+.45,5,0,glass,'x',40);cyl(g,1.55,1.55,1.3,x+.45,5,0,dark,'x');}const outerTube=cyl(g,3.2,3.2,45,0,5,0,glass,'x',40);outerTube.renderOrder=1;
 const innerTube=cyl(g,2.5,2.5,48,0,5,0,glass,'x',40);innerTube.renderOrder=2;
 // gemstone as garnet crystal octahedron
 let gem=new THREE.Mesh(new THREE.OctahedronGeometry(2.45),new THREE.MeshPhysicalMaterial({color:0xcf427a,metalness:.16,roughness:.11,transmission:.46,thickness:1.7,transparent:true,opacity:.84,depthWrite:false,emissive:0x4a071f,emissiveIntensity:.7}));gem.name='garnet_crystal';gem.position.set(1,5,0);gem.rotation.y=.35;g.add(gem);
 for(let x of [-23,-17,16,24]){let ring=new THREE.Mesh(new THREE.TorusGeometry(3.0,.035,6,64),new THREE.MeshBasicMaterial({color:0x74f9fc,transparent:true,opacity:.8}));ring.rotation.y=Math.PI/2;ring.position.set(x,5,0);g.add(ring);}
 const light=beam(g,[-36,5,0],[37,5,0],0x9bffff,.11);for(let x of [-23,16,30])flare(g,x,5,0,0x95ffff,6);particles(g,300,[34,13,18],[0,7,0],0x89ddf5,.11);return {group:g,beam:light,gem};}

export function buildWorld(scene){scene.background=new THREE.Color(C.bg);scene.fog=new THREE.FogExp2(C.bg,.006);scene.add(new THREE.HemisphereLight(0xbedbe7,0x14212d,2.0));const sun=new THREE.DirectionalLight(0xb5dcff,2.7);sun.position.set(30,65,50);scene.add(sun);
 const groups={},actors={};groups.exterior=makeExterior();groups.hall=makeHall();groups.pcb=makePCB();const atom=makeAtoms();groups.atoms=atom.group;actors.spin=atom.spin;const laser=makeLaser();groups.laser=laser.group;actors.laserBeam=laser.beam;const fiber=makeFiber();groups.fiber=fiber.group;actors.fiberBeam=fiber.beam;const optic=makeOptics();groups.optics=optic.group;actors.opticBeam=optic.beam;actors.gem=optic.gem;
 for(let [id,g]of Object.entries(groups)){scene.add(g);g.visible=false;}
 const replacements={};
 const defaultTransforms=Object.fromEntries(Object.entries(groups).map(([id,g])=>[id,g.position.clone()]));
 // Effects stay in the procedural group after its physical meshes are replaced.
 // Marked runtime FX: particles, glow sprites, and animated energy-beam meshes.
 function isRuntimeEffect(obj,root){for(let n=obj;n&&n!==root;n=n.parent){if(n.userData.runtimeEffect)return true;}return false;}
 function toggleProceduralGeometry(id,show){
   const root=groups[id];root.traverse(o=>{
     if(o===root)return;
     if((o.isMesh||o.isLine||o.isLineSegments||o.isPoints||o.isSprite)&&!isRuntimeEffect(o,root))o.visible=show;
   });
 }
 function modelForExport(id){
   if(!groups[id])throw Error('Unknown model: '+id);
   const root=groups[id].clone(true);root.name='Model_'+id;root.position.set(0,0,0);
   const removed=[];
   root.traverse(o=>{if(o!==root&&(o.userData.runtimeEffect||o.isPoints||o.isSprite))removed.push(o);});
   for(const o of removed){if(o.parent)o.parent.remove(o);}
   root.traverse(o=>{o.visible=true;});
   return root;
 }
 function replaceModel(id,newModel,transform={}){
   if(!groups[id])throw Error('Unknown model slot: '+id);
   if(replacements[id]){scene.remove(replacements[id]);}
   newModel.name='Linked_'+id;
   const base=defaultTransforms[id];
   const shift=transform.position||[0,0,0],rot=transform.rotation||[0,0,0],sca=transform.scale||[1,1,1];
   newModel.position.set(base.x+Number(shift[0]||0),base.y+Number(shift[1]||0),base.z+Number(shift[2]||0));
   newModel.rotation.set(...rot.map(Number));newModel.scale.set(...sca.map(Number));
   scene.add(newModel);replacements[id]=newModel;
   toggleProceduralGeometry(id,false);
   newModel.visible=groups[id].visible;
 }
 function restoreModel(id){
   if(!groups[id])return;
   if(replacements[id]){scene.remove(replacements[id]);delete replacements[id];}
   toggleProceduralGeometry(id,true);
 }

 const lamp1=new THREE.PointLight(0x8bebff,22,50);lamp1.position.set(180,11,14);scene.add(lamp1);const lamp2=new THREE.PointLight(0xffa86b,17,35);lamp2.position.set(360,8,10);scene.add(lamp2);const lamp3=new THREE.PointLight(0x80faff,14,48);lamp3.position.set(560,5,0);scene.add(lamp3);const lamp4=new THREE.PointLight(0x99ecff,17,50);lamp4.position.set(815,6,0);scene.add(lamp4);const lamps=[lamp1,lamp2,lamp3,lamp4];
 function update(t,shotId){const key=shotId==='hallreturn'?'hall':shotId==='finale'?'exterior':shotId;for(let [id,g] of Object.entries(groups))g.visible=id===key;for(let [id,g] of Object.entries(replacements))g.visible=id===key;for(let i=0;i<lamps.length;i++)lamps[i].visible=[key==='hall',key==='pcb',key==='laser'||key==='fiber',key==='optics'][i];actors.spin.rotation.y=.2+t*.045;actors.spin.rotation.z=Math.sin(t*.2)*.04;
 const linkedLattice=replacements.atoms?.getObjectByName('lattice_spin');
 if(linkedLattice){linkedLattice.rotation.y=actors.spin.rotation.y;linkedLattice.rotation.z=actors.spin.rotation.z;}
 const linkedGem=replacements.optics?.getObjectByName('garnet_crystal');
 if(linkedGem){linkedGem.rotation.y=.35+t*.085;linkedGem.rotation.x=.13+Math.sin(t*.3)*.1;}
 actors.gem.rotation.y=.35+t*.085;actors.gem.rotation.x=.13+Math.sin(t*.3)*.1;for(let b of [actors.laserBeam,actors.fiberBeam,actors.opticBeam]){b.core.material.opacity=.75+.19*Math.sin(t*8);b.aura.material.opacity=.038+.013*Math.sin(t*4);}
 scene.fog.density=key==='exterior'?.0045:key==='hall'?.003:.0025;
 }
 return {groups,actors,update,modelForExport,replaceModel,restoreModel,replacements};}
