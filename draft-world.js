import * as THREE from 'three';

// Phase 1 intentionally does NOT claim to reconstruct real geometry from video.
// These reusable guides make a generated timeline playable until AI/manual blockout.
export function createDraftWorld(scene) {
  const root = new THREE.Group();
  root.name = 'VideoDraftScene_GUIDES_ONLY';
  const mat = new THREE.MeshStandardMaterial({color:0x447e8e, roughness:0.7, metalness:0.2, transparent:true, opacity:0.77});
  const edgeMat = new THREE.LineBasicMaterial({color:0x9be8ec, transparent:true, opacity:0.55});
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(36, 36),
    new THREE.MeshStandardMaterial({color:0x132534, side:THREE.DoubleSide, roughness:1}));
  floor.rotation.x=-Math.PI/2; floor.position.y=-0.13; root.add(floor);
  const grid = new THREE.GridHelper(36,18,0x496e83,0x244052);
  grid.position.y=-0.1;root.add(grid);
  for (let i=0;i<6;i++) {
    const w=1.8 + (i%3)*0.5, h=2.6+(i%2)*2.6, d=2;
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
    mesh.position.set((i%3-1)*5,h/2,Math.floor(i/3)*-7);
    const edges=new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry),edgeMat);
    mesh.add(edges);root.add(mesh);
  }
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(2.5,2.5,0.5,32),
    new THREE.MeshStandardMaterial({color:0x3f5865,metalness:0.4,roughness:0.6}));
  pedestal.position.set(0,0.25,5);root.add(pedestal);
  scene.add(root);root.visible=false;
  let previousId=null;
  return {
    update(shot, hasCustomObjects = false) {
      const draft = !!(shot && !hasCustomObjects && (shot.draft === true || /^draft_/.test(shot.id)));
      root.visible=draft;
      if (!draft) {previousId=null;return;}
      if (shot.id!==previousId) {
        const colors={teal:[0x477f89,0x9be8ec],amber:[0x85654d,0xffc289],purple:[0x685d94,0xc2a9ff]};
        const [base,edge]=colors[shot.tone]||colors.teal;
        mat.color.setHex(base);edgeMat.color.setHex(edge);previousId=shot.id;
      }
    },
    root
  };
}
