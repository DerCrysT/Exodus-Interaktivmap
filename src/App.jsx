import { useState, useEffect, useRef, useCallback, useMemo } from "react"

// ═══════════════════════════════════════════════════════════════════════
// WORLD COORDINATE SYSTEM
// Bottom-Left (971.913, 184.008) → Top-Right (8036.71, 9267.07)
// PNG resolution: 6830 × 8745
// ═══════════════════════════════════════════════════════════════════════
const W = {
  xMin: 971.913025, xMax: 8036.71,
  zMin: 184.007996, zMax: 9267.070313,
  imgW: 6830,       imgH: 8745,
}
const wToP = (wx, wz) => ({
  x: (wx - W.xMin) / (W.xMax - W.xMin) * W.imgW,
  y: (W.zMax - wz) / (W.zMax - W.zMin) * W.imgH,
})
const pToW = (px, py) => ({
  x: px / W.imgW * (W.xMax - W.xMin) + W.xMin,
  z: W.zMax - py / W.imgH * (W.zMax - W.zMin),
})
const parsePos = str => {
  if (!str) return null
  const p = String(str).trim().split(/\s+/).map(Number)
  if (p.some(isNaN)) return null
  if (p.length >= 3) return { x: p[0], z: p[2] }
  if (p.length === 2) return { x: p[0], z: p[1] }
  return null
}

// ── Tier colour: golden-angle HSL so all 34 tiers are visually distinct
const tcol = id => {
  const n = parseInt(id)
  if (!n) return '#6b7280'
  const h = Math.round((n * 137.508) % 360)
  return `hsl(${h},72%,58%)`
}
const hexA = (hex, a) => {
  if (hex.startsWith('hsl')) {
    // convert hsl string to rgba approximately via a canvas trick isn't available; use opacity wrapper
    return hex.replace('hsl(', 'hsla(').replace(')', `,${a})`)
  }
  const r = parseInt(hex.slice(1,3),16)
  const g = parseInt(hex.slice(3,5),16)
  const b = parseInt(hex.slice(5,7),16)
  return `rgba(${r},${g},${b},${a})`
}

// ── Radiation tier by max intensity (mSv)
const radTier = maxMsv => {
  if (maxMsv <= 150) return { tier:1, color:'#22c55e',  label:'Tier 1 (≤150 mSv)' }
  if (maxMsv <= 350) return { tier:2, color:'#f59e0b',  label:'Tier 2 (≤350 mSv)' }
  return                    { tier:3, color:'#ef4444',  label:'Tier 3 (>350 mSv)' }
}

// ═══════════════════════════════════════════════════════════════════════
// DATA PARSERS
// ═══════════════════════════════════════════════════════════════════════

// Zones.json: each zone has a position (center) and spawnPoints[]
// spawnPoints have {position, radius, tierIds[], entities}
function parseZones(rawArr) {
  return rawArr.map(z => {
    const pos = parsePos(z.position || z.Position)
    if (!pos) return null
    const spawnPoints = (z.spawnPoints || z.SpawnPoints || []).map(sp => {
      const spos = parsePos(sp.position || sp.Position)
      if (!spos) return null
      return {
        pos:     spos,
        radius:  +(sp.radius || sp.Radius || 5),
        tierIds: (sp.tierIds || sp.TierIds || sp.tiers || []).map(String),
        entities: +(sp.entities || 1),
      }
    }).filter(Boolean)
    return {
      name:            z.name || z.Name || 'Zone',
      enabled:         z.enabled !== 0,
      pos,
      triggerRadius:   +(z.triggerRadius   || z.TriggerRadius   || 30),
      despawnDistance: +(z.despawnDistance || z.DespawnDistance || 150),
      spawnChance:     +(z.spawnChance     || 1),
      spawnPoints,
    }
  }).filter(Boolean)
}

// Tiers.json: { "tiers": { "1": { name, classnames[] } } }  OR  { "1": {...} }
function parseTiersJson(json) {
  const root = json.tiers || json.Tiers || json
  if (typeof root !== 'object' || Array.isArray(root)) return {}
  const out = {}
  Object.entries(root).forEach(([id, t]) => {
    out[String(id)] = {
      name:       t.name || t.Name || `Tier ${id}`,
      classnames: t.classnames || t.Classnames || [],
    }
  })
  return out
}

// RadiationZones.json: many possible structures
function parseRadiation(json) {
  let arr
  if      (Array.isArray(json))                arr = json
  else if (Array.isArray(json.RadiationZones)) arr = json.RadiationZones
  else if (Array.isArray(json.radiationZones)) arr = json.radiationZones
  else if (Array.isArray(json.Zones))          arr = json.Zones
  else if (Array.isArray(json.zones))          arr = json.zones
  else if (json.radiationCenter||json.center||json.position) arr = [json]
  else {
    const cand = Object.values(json).find(v => Array.isArray(v))
    arr = cand ?? []
  }
  return arr.map(r => {
    const pos = parsePos(r.radiationCenter||r.RadiationCenter||r.center||r.Center||r.position||r.Position)
    if (!pos) return null
    const iMax = +(r.intensityMax||r.IntensityMax||r.maxIntensity||50)
    const iMin = +(r.intensityMin||r.IntensityMin||r.minIntensity||5)
    // triggerRadius is the correct field per user data; fallback chain for other formats
    const radius = +(
      r.triggerRadius ?? r.TriggerRadius ??
      r.radius ?? r.Radius ??
      r.radiationRadius ?? r.RadiationRadius ?? 300
    )
    return {
      name:         r.name || r.Name || 'Rad Zone',
      pos,
      radius,           // used for rendering circle size
      intensityMin: iMin,
      intensityMax: iMax,
      rt:           radTier(iMax),
      raw:          r,
    }
  }).filter(Boolean)
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════
export default function App() {
  const canvasRef    = useRef(null)
  const containerRef = useRef(null)

  // ── State ───────────────────────────────────────────────────────────
  const [mapImg,     setMapImg]     = useState(null)
  const [zones,      setZones]      = useState([])
  const [tiers,      setTiers]      = useState({})      // { id → {name, classnames} }
  const [radiation,  setRadiation]  = useState([])
  const [anomalies,  setAnomalies]  = useState(null)

  // tierFilter: null = all visible; Set<string> = only those tier IDs shown
  const [tierFilter, setTierFilter] = useState(null)

  const [layers, setLayers] = useState({
    triggerRadius:true, despawnRadius:false,
    spawnPoints:true, spawnRadius:true,
    zoneNames:false,
    radiation:true,
    teleports:true, dynAnom:true, statAnom:true,
  })
  const [tool,        setTool]        = useState('pan')
  const [selectedIds, setSelectedIds] = useState(null)  // drag-select zone name filter
  const [inspected,   setInspected]   = useState(null)  // zone clicked
  const [cursor,      setCursor]      = useState({x:0,z:0})
  const [zoomPct,     setZoomPct]     = useState(7)
  const [sections,    setSections]    = useState({info:true,mutants:true,rad:true,anom:true,stashes:false})
  const [toast,       setToast]       = useState(null)
  const [radFilter,   setRadFilter]   = useState(new Set([1,2,3]))  // radiation tier filter
  // editMode (radiation): null | { idx, draft }
  const [editMode,    setEditMode]    = useState(null)
  // zoneEditMode: null | { idx, draft:{name,pos,triggerRadius,despawnDistance} }
  const [zoneEdit,    setZoneEdit]    = useState(null)
  // contextMenu: null | { cx,cy,wx,wz }  (canvas px position + world coords)
  const [ctxMenu,     setCtxMenu]     = useState(null)

  // ── Refs ────────────────────────────────────────────────────────────
  const tfm        = useRef({ x:0, y:0, scale:0.07 })
  const RS         = useRef({})          // render state mirror
  const needRender = useRef(true)
  const rafId      = useRef(null)
  const mark       = () => { needRender.current = true }

  // keep render state current
  useEffect(() => {
    RS.current = { mapImg, zones, tiers, radiation, anomalies, layers, tierFilter, selectedIds, inspected, radFilter, editMode, zoneEdit }
    mark()
  }, [mapImg, zones, tiers, radiation, anomalies, layers, tierFilter, selectedIds, inspected, radFilter, editMode, zoneEdit])

  // ── Derived ─────────────────────────────────────────────────────────
  const tierList = useMemo(() =>
    Object.entries(tiers)
      .sort((a,b) => +a[0] - +b[0])
      .map(([id,t]) => ({ id, name: t.name, color: tcol(id) }))
  , [tiers])

  // collect all tier IDs actually used in zones
  const usedTierIds = useMemo(() => {
    const s = new Set()
    zones.forEach(z => z.spawnPoints.forEach(sp => sp.tierIds.forEach(id => s.add(id))))
    return s
  }, [zones])

  const visibleTiers = useMemo(() =>
    tierList.filter(t => usedTierIds.has(t.id))
  , [tierList, usedTierIds])

  const spCountByTier = useMemo(() => {
    const m = {}
    zones.forEach(z => z.spawnPoints.forEach(sp =>
      sp.tierIds.forEach(id => { m[id] = (m[id]||0)+1 })
    ))
    return m
  }, [zones])

  // ── Clear inspected when its layer turns off ──────────────────────────
  useEffect(() => {
    if (!inspected) return
    const t = inspected.type
    const L = layers
    const mutantsVisible = L.triggerRadius || L.despawnRadius || L.spawnPoints
    if (t === 'zone'      && !mutantsVisible) setInspected(null)
    if (t === 'radiation' && !L.radiation)    setInspected(null)
    if (t === 'statAnom'  && !L.statAnom)     setInspected(null)
    if (t === 'dynAnom'   && !L.dynAnom)      setInspected(null)
    if (t === 'teleport'  && !L.teleports)    setInspected(null)
  }, [layers, inspected])

  // Clear inspected zone when its tier is filtered out
  useEffect(() => {
    if (!inspected || inspected.type !== 'zone') return
    if (!tierFilter) return
    const sp = inspected.data.spawnPoints
    if (sp.length > 0 && !sp.some(p => p.tierIds.some(id => tierFilter.has(String(id))))) {
      setInspected(null)
    }
  }, [tierFilter, inspected])

  // ═══════════════════════════════════════════════════════════════════
  // RAF RENDER LOOP
  // ═══════════════════════════════════════════════════════════════════
  const draw = useCallback(() => {
    rafId.current = requestAnimationFrame(draw)
    if (!needRender.current) return
    needRender.current = false

    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d')
    const CW=canvas.width, CH=canvas.height
    const {x:tx,y:ty,scale:sc} = tfm.current
    const rs = RS.current
    const {mapImg:img, zones:zns=[], radiation:rads=[], anomalies:anom,
           layers:L={}, tierFilter:TF, selectedIds:SI, inspected:IZ,
           radFilter:RF, selRect:SR} = rs
    const ppu = W.imgW / (W.xMax - W.xMin)

    // Background
    ctx.fillStyle='#07090d'; ctx.fillRect(0,0,CW,CH)
    ctx.save(); ctx.translate(tx,ty); ctx.scale(sc,sc)

    // ── Map
    if (img) {
      ctx.drawImage(img, 0, 0, W.imgW, W.imgH)
    } else {
      ctx.fillStyle='#0b1018'; ctx.fillRect(0,0,W.imgW,W.imgH)
      ctx.fillStyle='#1a2030'; ctx.font=`${140}px monospace`
      ctx.textAlign='center'; ctx.textBaseline='middle'
      ctx.fillText('← Karte importieren', W.imgW/2, W.imgH/2)
    }

    // ── Filter zones by drag-select
    let visZones = SI ? zns.filter(z=>SI.has(z.name)) : zns

    // ── For a zone to be drawn, it needs at least one visible spawnPoint (or no spawnPoints at all)
    const zoneHasVisibleSP = z => {
      if (!z.spawnPoints.length) return true
      if (!TF) return true
      return z.spawnPoints.some(sp => sp.tierIds.some(id => TF.has(String(id))))
    }
    visZones = visZones.filter(zoneHasVisibleSP)

    // ── Despawn radius
    if (L.despawnRadius) {
      visZones.forEach(z => {
        const p=wToP(z.pos.x,z.pos.z), r=z.despawnDistance*ppu
        ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2)
        ctx.fillStyle='rgba(100,120,200,0.04)'; ctx.strokeStyle='rgba(100,120,200,0.22)'
        ctx.lineWidth=3/sc; ctx.fill(); ctx.stroke()
      })
    }

    // ── Trigger radius (zone outer ring)
    if (L.triggerRadius) {
      visZones.forEach(z => {
        const p=wToP(z.pos.x,z.pos.z), r=Math.max(z.triggerRadius*ppu,3/sc)
        ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2)
        ctx.fillStyle='rgba(148,163,184,0.05)'; ctx.strokeStyle='rgba(148,163,184,0.35)'
        ctx.lineWidth=1.5/sc; ctx.fill(); ctx.stroke()
        // center cross
        const cs=Math.max(6/sc,2)
        ctx.beginPath(); ctx.moveTo(p.x-cs,p.y); ctx.lineTo(p.x+cs,p.y)
        ctx.moveTo(p.x,p.y-cs); ctx.lineTo(p.x,p.y+cs)
        ctx.strokeStyle='rgba(148,163,184,0.5)'; ctx.lineWidth=1/sc; ctx.stroke()
      })
    }

    // ── Individual SpawnPoints
    if (L.spawnPoints) {
      visZones.forEach(z => {
        z.spawnPoints.forEach(sp => {
          if (TF && !sp.tierIds.some(id=>TF.has(String(id)))) return
          const p=wToP(sp.pos.x,sp.pos.z)
          const mainId = sp.tierIds[0]
          const c = tcol(mainId)

          // Spawn radius circle
          if (L.spawnRadius) {
            const r = Math.max(sp.radius*ppu, 2/sc)
            ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2)
            ctx.fillStyle=hexA(c,0.18); ctx.strokeStyle=hexA(c,0.55)
            ctx.lineWidth=1/sc; ctx.fill(); ctx.stroke()
          }

          // Center dot
          const dr=Math.max(4/sc,1.8)
          ctx.beginPath(); ctx.arc(p.x,p.y,dr,0,Math.PI*2)
          ctx.fillStyle=c; ctx.strokeStyle='rgba(0,0,0,0.65)'; ctx.lineWidth=0.8/sc
          ctx.fill(); ctx.stroke()

          // Multiple tier IDs → small extra dots
          if (sp.tierIds.length>1) {
            sp.tierIds.slice(1).forEach((id,i)=>{
              const off=(i+1)*(dr*2.4)
              ctx.beginPath(); ctx.arc(p.x+off,p.y,dr*0.7,0,Math.PI*2)
              ctx.fillStyle=tcol(id); ctx.fill()
            })
          }
        })
      })
    }

    // ── Zone names
    if (L.zoneNames && sc>0.07) {
      const fs=Math.max(11/sc,7)
      ctx.font=`${fs}px "Courier New",monospace`
      ctx.textAlign='center'; ctx.textBaseline='bottom'
      visZones.forEach(z=>{
        const p=wToP(z.pos.x,z.pos.z)
        ctx.lineWidth=3/sc; ctx.strokeStyle='rgba(0,0,0,0.85)'
        ctx.strokeText(z.name,p.x,p.y-8/sc)
        ctx.fillStyle='#e2e8f0'; ctx.fillText(z.name,p.x,p.y-8/sc)
      })
    }

    // ── Inspected highlight (works for any {type,data} object)
    if (IZ) {
      const d=IZ.data, pos=d.pos
      if(pos) {
        const r=Math.max((d.triggerRadius||d.radius||20)*ppu, 12/sc)
        const hcol = IZ.type==='radiation' ? d.rt?.color||'#22c55e'
                   : IZ.type==='statAnom'  ? '#60a5fa'
                   : IZ.type==='dynAnom'   ? '#f59e0b'
                   : IZ.type==='teleport'  ? '#a855f7'
                   : '#ffffff'
        const p=wToP(pos.x,pos.z)
        ctx.beginPath(); ctx.arc(p.x,p.y,r+6/sc,0,Math.PI*2)
        ctx.strokeStyle=hcol; ctx.lineWidth=2.5/sc; ctx.stroke()
        ctx.beginPath(); ctx.arc(p.x,p.y,r+16/sc,0,Math.PI*2)
        ctx.strokeStyle=hexA(hcol,0.25); ctx.lineWidth=1.5/sc; ctx.stroke()
      }
    }

    // ── Radiation zones (solid flat color by intensity tier)
    if (L.radiation) {
      rads.forEach(rad=>{
        if (!RF || !RF.has(rad.rt.tier)) return
        const p=wToP(rad.pos.x,rad.pos.z), r=rad.radius*ppu
        const c=rad.rt.color
        ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2)
        ctx.fillStyle=hexA(c,0.2); ctx.strokeStyle=hexA(c,0.75)
        ctx.lineWidth=2.5/sc; ctx.fill(); ctx.stroke()
        // Inner pulse ring
        ctx.beginPath(); ctx.arc(p.x,p.y,r*0.3,0,Math.PI*2)
        ctx.fillStyle=hexA(c,0.35); ctx.fill()
        if (sc>0.1) {
          const fs=Math.max(16/sc,10)
          ctx.font=`bold ${fs}px monospace`; ctx.textAlign='center'; ctx.textBaseline='middle'
          ctx.fillStyle=hexA(c,0.9); ctx.fillText('☢',p.x,p.y)
          if (sc>0.25) {
            const fs2=Math.max(10/sc,7)
            ctx.font=`${fs2}px monospace`
            ctx.fillStyle=hexA(c,0.8)
            ctx.fillText(rad.name,p.x,p.y+fs*0.9)
            ctx.font=`${fs2*0.85}px monospace`
            ctx.fillStyle=hexA(c,0.6)
            ctx.fillText(`${rad.intensityMin}–${rad.intensityMax} mSv`,p.x,p.y+fs*0.9+fs2*1.1)
          }
        }
      })
    }

    // ── Teleports
    if (L.teleports && anom?.Teleports) {
      anom.Teleports.forEach(tp=>{
        const fr=parsePos(tp.position_by||tp.positionBy||tp.from||tp.From)
        const to=parsePos(tp.position_to||tp.positionTo||tp.to||tp.To)
        if(!fr||!to) return
        const pF=wToP(fr.x,fr.z), pT=wToP(to.x,to.z)
        ctx.beginPath(); ctx.moveTo(pF.x,pF.y); ctx.lineTo(pT.x,pT.y)
        ctx.strokeStyle='rgba(168,85,247,0.75)'; ctx.lineWidth=2.5/sc
        ctx.setLineDash([12/sc,6/sc]); ctx.stroke(); ctx.setLineDash([])
        const ang=Math.atan2(pT.y-pF.y,pT.x-pF.x),al=18/sc
        ctx.beginPath()
        ctx.moveTo(pT.x,pT.y)
        ctx.lineTo(pT.x-al*Math.cos(ang-0.45),pT.y-al*Math.sin(ang-0.45))
        ctx.lineTo(pT.x-al*Math.cos(ang+0.45),pT.y-al*Math.sin(ang+0.45))
        ctx.closePath(); ctx.fillStyle='rgba(168,85,247,0.9)'; ctx.fill()
        ;[[pF,'#60a5fa'],[pT,'#a855f7']].forEach(([pt,c])=>{
          ctx.beginPath(); ctx.arc(pt.x,pt.y,Math.max(6/sc,2),0,Math.PI*2)
          ctx.fillStyle=c; ctx.strokeStyle='rgba(0,0,0,.5)'; ctx.lineWidth=1/sc; ctx.fill(); ctx.stroke()
        })
      })
    }

    // ── Dynamic anomalies
    if (L.dynAnom && anom?.AnomaliesDynamic) {
      anom.AnomaliesDynamic.forEach(f=>{
        const pos=parsePos(f.position); if(!pos) return
        const p=wToP(pos.x,pos.z),r=(f.radius||150)*ppu
        ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2)
        ctx.fillStyle='rgba(245,158,11,0.1)'; ctx.strokeStyle='rgba(245,158,11,0.6)'
        ctx.lineWidth=2/sc; ctx.setLineDash([10/sc,5/sc])
        ctx.fill(); ctx.stroke(); ctx.setLineDash([])
        ctx.beginPath(); ctx.arc(p.x,p.y,Math.max(5/sc,2),0,Math.PI*2)
        ctx.fillStyle='#f59e0b'; ctx.fill()
      })
    }

    // ── Static anomalies
    if (L.statAnom && anom?.AnomaliesStatic) {
      anom.AnomaliesStatic.forEach(sa=>{
        const pos=parsePos(sa.position); if(!pos) return
        const p=wToP(pos.x,pos.z),c=tcol(sa.tier||sa.Tier||1),s=Math.max(7/sc,2.5)
        ctx.beginPath()
        ctx.moveTo(p.x,p.y-s); ctx.lineTo(p.x+s,p.y)
        ctx.lineTo(p.x,p.y+s); ctx.lineTo(p.x-s,p.y)
        ctx.closePath()
        ctx.fillStyle=c; ctx.strokeStyle='rgba(0,0,0,.7)'; ctx.lineWidth=1/sc; ctx.fill(); ctx.stroke()
      })
    }


    // ── Edit mode: draw draft radiation zone on top
    const EM = rs.editMode
    if (EM) {
      const d = EM.draft
      const ep = wToP(d.pos.x, d.pos.z)
      const er = Math.max(d.radius * ppu, 3/sc)
      const ec = d.rt.color
      ctx.beginPath(); ctx.arc(ep.x, ep.y, er, 0, Math.PI*2)
      ctx.fillStyle = hexA(ec, 0.18); ctx.strokeStyle = ec
      ctx.lineWidth = 2.5/sc; ctx.setLineDash([14/sc,7/sc])
      ctx.fill(); ctx.stroke(); ctx.setLineDash([])
      ctx.beginPath(); ctx.arc(ep.x, ep.y, er*0.28, 0, Math.PI*2)
      ctx.fillStyle = hexA(ec, 0.45); ctx.fill()
      const cs = Math.max(14/sc, 5)
      ctx.strokeStyle = ec; ctx.lineWidth = 1.5/sc
      ctx.beginPath()
      ctx.moveTo(ep.x-cs, ep.y); ctx.lineTo(ep.x+cs, ep.y)
      ctx.moveTo(ep.x, ep.y-cs); ctx.lineTo(ep.x, ep.y+cs)
      ctx.stroke()
      ctx.beginPath(); ctx.arc(ep.x, ep.y, Math.max(8/sc, 3), 0, Math.PI*2)
      ctx.fillStyle = ec; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1/sc; ctx.fill(); ctx.stroke()
      if (sc > 0.07) {
        const fs = Math.max(12/sc, 8)
        ctx.font = `bold ${fs}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
        ctx.strokeStyle='rgba(0,0,0,0.85)'; ctx.lineWidth=3/sc
        ctx.strokeText(`[EDIT] ${d.name}`, ep.x, ep.y - er - 6/sc)
        ctx.fillStyle = ec; ctx.fillText(`[EDIT] ${d.name}`, ep.x, ep.y - er - 6/sc)
        ctx.font = `${Math.max(10/sc,7)}px monospace`; ctx.textBaseline='middle'; ctx.textAlign='left'
        ctx.strokeText(`r=${d.radius}m`, ep.x+er+8/sc, ep.y)
        ctx.fillStyle = hexA(ec,0.9); ctx.fillText(`r=${d.radius}m`, ep.x+er+8/sc, ep.y)
      }
    }

    // ── Zone edit preview: trigger + despawn rings with drag handle
    const ZE = rs.zoneEdit
    if (ZE) {
      const d = ZE.draft
      const ep = wToP(d.pos.x, d.pos.z)
      // Despawn ring
      const rd = Math.max(d.despawnDistance * ppu, 3/sc)
      ctx.beginPath(); ctx.arc(ep.x, ep.y, rd, 0, Math.PI*2)
      ctx.fillStyle='rgba(250,204,21,0.06)'; ctx.strokeStyle='rgba(250,204,21,0.6)'
      ctx.lineWidth=2/sc; ctx.setLineDash([12/sc,6/sc]); ctx.fill(); ctx.stroke(); ctx.setLineDash([])
      // Trigger ring
      const rt2 = Math.max(d.triggerRadius * ppu, 3/sc)
      ctx.beginPath(); ctx.arc(ep.x, ep.y, rt2, 0, Math.PI*2)
      ctx.fillStyle='rgba(148,163,184,0.1)'; ctx.strokeStyle='#94a3b8'
      ctx.lineWidth=2/sc; ctx.setLineDash([10/sc,5/sc]); ctx.fill(); ctx.stroke(); ctx.setLineDash([])
      // Center crosshair + handle
      const cs2 = Math.max(14/sc, 5)
      ctx.strokeStyle='#94a3b8'; ctx.lineWidth=1.5/sc
      ctx.beginPath(); ctx.moveTo(ep.x-cs2,ep.y); ctx.lineTo(ep.x+cs2,ep.y)
      ctx.moveTo(ep.x,ep.y-cs2); ctx.lineTo(ep.x,ep.y+cs2); ctx.stroke()
      ctx.beginPath(); ctx.arc(ep.x, ep.y, Math.max(8/sc,3), 0, Math.PI*2)
      ctx.fillStyle='#94a3b8'; ctx.strokeStyle='rgba(0,0,0,0.6)'; ctx.lineWidth=1/sc; ctx.fill(); ctx.stroke()
      // Label
      if (sc > 0.07) {
        const fs = Math.max(12/sc, 8)
        ctx.font=`bold ${fs}px monospace`; ctx.textAlign='center'; ctx.textBaseline='bottom'
        ctx.strokeStyle='rgba(0,0,0,0.85)'; ctx.lineWidth=3/sc
        ctx.strokeText(`[EDIT] ${d.name}`, ep.x, ep.y - rt2 - 6/sc)
        ctx.fillStyle='#94a3b8'; ctx.fillText(`[EDIT] ${d.name}`, ep.x, ep.y - rt2 - 6/sc)
        ctx.font=`${Math.max(10/sc,7)}px monospace`; ctx.textBaseline='middle'; ctx.textAlign='left'
        ctx.strokeText(`T:${d.triggerRadius}m  D:${d.despawnDistance}m`, ep.x+rt2+8/sc, ep.y)
        ctx.fillStyle='rgba(148,163,184,0.9)'; ctx.fillText(`T:${d.triggerRadius}m  D:${d.despawnDistance}m`, ep.x+rt2+8/sc, ep.y)
      }
    }

    // ── Drag-select rectangle
    if (SR) {
      const rx=Math.min(SR.x1,SR.x2),ry=Math.min(SR.y1,SR.y2)
      const rw=Math.abs(SR.x2-SR.x1),rh=Math.abs(SR.y2-SR.y1)
      ctx.beginPath(); ctx.rect(rx,ry,rw,rh)
      ctx.fillStyle='rgba(96,165,250,0.1)'; ctx.strokeStyle='rgba(96,165,250,0.9)'
      ctx.lineWidth=1.5/sc; ctx.setLineDash([8/sc,4/sc])
      ctx.fill(); ctx.stroke(); ctx.setLineDash([])
    }

    ctx.restore()
  }, [])

  useEffect(()=>{ rafId.current=requestAnimationFrame(draw); return ()=>cancelAnimationFrame(rafId.current) },[draw])

  // ── Canvas resize ───────────────────────────────────────────────────
  useEffect(()=>{
    const resize=()=>{ const c=canvasRef.current,ct=containerRef.current; if(!c||!ct) return; c.width=ct.clientWidth; c.height=ct.clientHeight; mark() }
    resize(); window.addEventListener('resize',resize); return ()=>window.removeEventListener('resize',resize)
  },[])

  // ── Non-passive wheel ───────────────────────────────────────────────
  useEffect(()=>{
    const el=canvasRef.current; if(!el) return
    const h=e=>{ e.preventDefault(); const r=el.getBoundingClientRect(),cx=e.clientX-r.left,cy=e.clientY-r.top,t=tfm.current,d=e.deltaY>0?0.85:1.18,ns=Math.min(Math.max(t.scale*d,.015),14); t.x=cx-(cx-t.x)*(ns/t.scale); t.y=cy-(cy-t.y)*(ns/t.scale); t.scale=ns; setZoomPct(Math.round(ns*100)); mark() }
    el.addEventListener('wheel',h,{passive:false}); return ()=>el.removeEventListener('wheel',h)
  },[])

  // ── Center map ──────────────────────────────────────────────────────
  const centerMap = useCallback(()=>{
    const ct=containerRef.current; if(!ct) return
    const cw=ct.clientWidth,ch=ct.clientHeight,sc=Math.min(cw/W.imgW,ch/W.imgH)*0.94
    tfm.current={x:(cw-W.imgW*sc)/2,y:(ch-W.imgH*sc)/2,scale:sc}; setZoomPct(Math.round(sc*100)); mark()
  },[])

  // ── Coord helpers ───────────────────────────────────────────────────
  const getCP   = e=>{ const r=canvasRef.current.getBoundingClientRect(); return {x:e.clientX-r.left,y:e.clientY-r.top} }
  const cpToImg = (cx,cy)=>{ const {x:tx,y:ty,scale:sc}=tfm.current; return {x:(cx-tx)/sc,y:(cy-ty)/sc} }

  // Returns {type:'zone'|'radiation'|'teleport'|'dynAnom'|'statAnom', data} or null
  // Only searches layers that are currently visible
  const findAny = useCallback((imgX,imgY)=>{
    const {zones:zns=[], radiation:rads=[], anomalies:anom, layers:L={}, tierFilter:TF, radFilter:RF} = RS.current
    const ppu    = W.imgW/(W.xMax-W.xMin)
    const minHit = 22/tfm.current.scale
    let best=null, bestD=Infinity

    const check = (pos, hitR, candidate) => {
      const p=wToP(pos.x,pos.z)
      const d=Math.hypot(p.x-imgX,p.y-imgY)
      const hit=Math.max(hitR*ppu, minHit)
      if(d<hit && d<bestD){ best=candidate; bestD=d }
    }

    // Mutant zones — only if at least one mutant layer is on
    const mutantsActive = L.triggerRadius||L.despawnRadius||L.spawnPoints
    if(mutantsActive) {
      zns.forEach(z=>{
        if(TF && z.spawnPoints.length>0 && !z.spawnPoints.some(sp=>sp.tierIds.some(id=>TF.has(String(id))))) return
        check(z.pos, z.triggerRadius, {type:'zone', data:z})
      })
    }

    // Radiation zones
    if(L.radiation) {
      rads.forEach(rad=>{
        if(RF && !RF.has(rad.rt.tier)) return
        check(rad.pos, rad.radius, {type:'radiation', data:rad})
      })
    }

    // Static anomalies
    if(anom && L.statAnom && anom.AnomaliesStatic) {
      anom.AnomaliesStatic.forEach(sa=>{
        const pos=parsePos(sa.position||sa.Position); if(!pos) return
        check(pos, 20, {type:'statAnom', data:{...sa, pos}})
      })
    }
    // Dynamic anomaly fields
    if(anom && L.dynAnom && anom.AnomaliesDynamic) {
      anom.AnomaliesDynamic.forEach(f=>{
        const pos=parsePos(f.position||f.Position); if(!pos) return
        check(pos, f.radius||150, {type:'dynAnom', data:{...f, pos}})
      })
    }
    // Teleports (from-position)
    if(anom && L.teleports && anom.Teleports) {
      anom.Teleports.forEach(tp=>{
        const pos=parsePos(tp.position_by||tp.positionBy||tp.from||tp.From); if(!pos) return
        check(pos, 30, {type:'teleport', data:{...tp, pos}})
      })
    }

    return best
  },[])

  // ═══════════════════════════════════════════════════════════════════
  // MOUSE INTERACTION
  // Uses window-level listeners during drag so motion outside canvas works
  // ═══════════════════════════════════════════════════════════════════
  const dragState = useRef({ active:false, type:null, panStart:{}, selStart:{}, hasMoved:false, lastClick:0, clickTimer:null })

  const onCanvasMouseDown = useCallback(e=>{
    if(e.button!==0) return
    e.preventDefault()
    const cp=getCP(e)
    const ds=dragState.current
    ds.hasMoved=false

    // ── Shift+LMB → open context menu at clicked world position
    if(e.shiftKey && toolRef.current==='pan') {
      e.preventDefault()
      const ip=cpToImg(cp.x,cp.y)
      const wc=pToW(ip.x,ip.y)
      setCtxMenu({ cx:cp.x, cy:cp.y, wx:wc.x, wz:wc.z })
      return
    }

    // ── Zone-edit drag (move spawn zone center)
    if(RS.current.zoneEdit) {
      const ze=RS.current.zoneEdit
      const ip=cpToImg(cp.x,cp.y)
      const ep=wToP(ze.draft.pos.x,ze.draft.pos.z)
      const ppu2=W.imgW/(W.xMax-W.xMin)
      const hitR=Math.max(16/tfm.current.scale,ze.draft.triggerRadius*ppu2*0.5)
      if(Math.hypot(ip.x-ep.x,ip.y-ep.y)<hitR){
        ds.active=true; ds.type='zoneDrag'
        ds.editOffset={dx:ip.x-ep.x,dy:ip.y-ep.y}
        const onMoveZ=ev=>{
          const rz=canvasRef.current?.getBoundingClientRect(); if(!rz) return
          const ip2=cpToImg(ev.clientX-rz.left,ev.clientY-rz.top)
          const wc2=pToW(ip2.x-ds.editOffset.dx,ip2.y-ds.editOffset.dy)
          setZoneEdit(prev=>prev?({...prev,draft:{...prev.draft,pos:{x:+wc2.x.toFixed(3),z:+wc2.z.toFixed(3)}}}):null)
          setCursor({x:+wc2.x.toFixed(1),z:+wc2.z.toFixed(1)})
        }
        const onUpZ=()=>{window.removeEventListener('mousemove',onMoveZ);window.removeEventListener('mouseup',onUpZ);ds.active=false}
        window.addEventListener('mousemove',onMoveZ); window.addEventListener('mouseup',onUpZ)
        return
      }
    }

    // ── Edit mode: drag zone center ──────────────────────────────────────
    if(RS.current.editMode) {
      const em = RS.current.editMode
      const ip = cpToImg(cp.x,cp.y)
      const p  = wToP(em.draft.pos.x, em.draft.pos.z)
      const ppu= W.imgW/(W.xMax-W.xMin)
      const handleR = Math.max(16/tfm.current.scale, em.draft.radius*ppu*0.5)
      // If click is within handle radius → start drag
      if(Math.hypot(ip.x-p.x, ip.y-p.y) < handleR) {
        ds.active=true; ds.type='editDrag'
        ds.editOffset={ dx: ip.x-p.x, dy: ip.y-p.y }
        const onMove2=e2=>{
          const r2=canvasRef.current?.getBoundingClientRect(); if(!r2) return
          const cx2=e2.clientX-r2.left, cy2=e2.clientY-r2.top
          const ip2=cpToImg(cx2,cy2)
          const wc=pToW(ip2.x-ds.editOffset.dx, ip2.y-ds.editOffset.dy)
          // Update draft pos
          setEditMode(prev=>prev?({...prev,draft:{...prev.draft,pos:{x:+wc.x.toFixed(3),z:+wc.z.toFixed(3)}}}):null)
          setCursor({x:+wc.x.toFixed(1),z:+wc.z.toFixed(1)})
        }
        const onUp2=()=>{ window.removeEventListener('mousemove',onMove2); window.removeEventListener('mouseup',onUp2); ds.active=false }
        window.addEventListener('mousemove',onMove2); window.addEventListener('mouseup',onUp2)
        return
      }
    }

    if(toolRef.current==='select') {
      const ip=cpToImg(cp.x,cp.y)
      ds.active=true; ds.type='select'; ds.selStart=ip
      RS.current.selRect={x1:ip.x,y1:ip.y,x2:ip.x,y2:ip.y}; mark()
    } else {
      ds.active=true; ds.type='pan'
      ds.panStart={mx:cp.x,my:cp.y,tx:tfm.current.x,ty:tfm.current.y}
    }

    const onMove=e=>{
      const r=canvasRef.current?.getBoundingClientRect(); if(!r) return
      const cx=e.clientX-r.left, cy=e.clientY-r.top
      const ip=cpToImg(cx,cy)
      const wc=pToW(ip.x,ip.y)
      setCursor({x:+wc.x.toFixed(1),z:+wc.z.toFixed(1)})

      if(!ds.active) return
      if(ds.type==='pan'){
        const mx=e.clientX-r.left, my=e.clientY-r.top
        if(Math.hypot(mx-ds.panStart.mx,my-ds.panStart.my)>3) ds.hasMoved=true
        tfm.current.x=ds.panStart.tx+(mx-ds.panStart.mx)
        tfm.current.y=ds.panStart.ty+(my-ds.panStart.my)
        mark()
      } else if(ds.type==='select'){
        ds.hasMoved=true
        RS.current.selRect={x1:ds.selStart.x,y1:ds.selStart.y,x2:ip.x,y2:ip.y}; mark()
      }
    }

    const onUp=e=>{
      window.removeEventListener('mousemove',onMove)
      window.removeEventListener('mouseup',onUp)

      if(ds.type==='select'&&ds.active){
        const sr=RS.current.selRect
        if(sr&&(Math.abs(sr.x2-sr.x1)>8||Math.abs(sr.y2-sr.y1)>8)){
          const rx1=Math.min(sr.x1,sr.x2),rx2=Math.max(sr.x1,sr.x2)
          const ry1=Math.min(sr.y1,sr.y2),ry2=Math.max(sr.y1,sr.y2)
          const inside=(RS.current.zones||[]).filter(z=>{const p=wToP(z.pos.x,z.pos.z);return p.x>=rx1&&p.x<=rx2&&p.y>=ry1&&p.y<=ry2})
          setSelectedIds(inside.length?new Set(inside.map(z=>z.name)):null)
        }
        RS.current.selRect=null; mark()
      }

      if(ds.type==='pan'&&!ds.hasMoved){
        const r=canvasRef.current?.getBoundingClientRect(); if(!r) return
        const cx=e.clientX-r.left,cy=e.clientY-r.top
        const ip=cpToImg(cx,cy)
        const now=Date.now()
        if(now-ds.lastClick<350){
          clearTimeout(ds.clickTimer)
          const hit=findAny(ip.x,ip.y)
          if(hit){setInspected(hit);setSections(s=>({...s,info:true}))}
        } else {
          ds.clickTimer=setTimeout(()=>{
            const hit=findAny(ip.x,ip.y)
            setInspected(hit??null)
            if(hit) setSections(s=>({...s,info:true}))
          },350)
        }
        ds.lastClick=now
      }
      ds.active=false
    }

    window.addEventListener('mousemove',onMove)
    window.addEventListener('mouseup',onUp)
  },[findAny])

  const toolRef = useRef('pan')
  useEffect(()=>{ toolRef.current=tool },[tool])

  // ── Move-only handler for cursor coord display when not dragging
  const onCanvasMouseMove = useCallback(e=>{
    if(dragState.current.active) return   // handled by window listener
    const cp=getCP(e),ip=cpToImg(cp.x,cp.y),wc=pToW(ip.x,ip.y)
    setCursor({x:+wc.x.toFixed(1),z:+wc.z.toFixed(1)})
  },[])

  // ═══════════════════════════════════════════════════════════════════
  // FILE IMPORT
  // Uses FileReader.readAsDataURL for images (works in sandboxed iframes)
  // ═══════════════════════════════════════════════════════════════════
  const showToast = useCallback((msg,type='ok')=>{
    setToast({msg,type}); setTimeout(()=>setToast(null),4000)
  },[])

  const handleFile = useCallback(async(file,type)=>{
    try {
      if(type==='map'){
        // Use FileReader (readAsDataURL) — works in sandboxed canvas contexts
        const reader = new FileReader()
        reader.onload = ev => {
          const img = new Image()
          img.onload  = () => { setMapImg(img); RS.current.mapImg=img; mark(); setTimeout(centerMap,60) }
          img.onerror = () => showToast('Bild konnte nicht geladen werden','error')
          img.src = ev.target.result   // data:image/...;base64,...
        }
        reader.onerror = () => showToast('Datei konnte nicht gelesen werden','error')
        reader.readAsDataURL(file)
        showToast(`Karte: ${file.name}`)
        return
      }
      const txt  = await file.text()
      const json = JSON.parse(txt)
      if(type==='zones'){
        const raw = Array.isArray(json)?json:(json.Zones||json.zones||json.spawnZones||json.SpawnZones||[])
        const parsed = parseZones(raw)
        setZones(parsed); showToast(`${parsed.length} Zonen, ${parsed.reduce((s,z)=>s+z.spawnPoints.length,0)} SpawnPoints`)
      } else if(type==='tiers'){
        const parsed=parseTiersJson(json)
        setTiers(parsed); showToast(`${Object.keys(parsed).length} Tiers geladen`)
      } else if(type==='radiation'){
        const parsed=parseRadiation(json)
        setRadiation(parsed)
        RS.current.radiation=parsed; mark()
        showToast(parsed.length?`${parsed.length} Strahlungszonen`:'Keine Zonen gefunden!','error')
      } else if(type==='anomalies'){
        setAnomalies(json); RS.current.anomalies=json; mark()
        showToast(`${(json.Teleports||[]).length}T · ${(json.AnomaliesDynamic||[]).length}D · ${(json.AnomaliesStatic||[]).length}S`)
      }
    } catch(err){ showToast(`Fehler: ${err.message}`,'error') }
  },[centerMap,showToast])

  const onFile = (e,type)=>{ const f=e.target.files[0]; if(f) handleFile(f,type); e.target.value='' }

  // ── Tier filter toggle ──────────────────────────────────────────────
  const toggleTier = id => {
    setTierFilter(prev => {
      const allIds = new Set(visibleTiers.map(t=>t.id))
      const base   = prev ?? new Set(allIds)   // null → all selected
      const next   = new Set(base)
      next.has(id) ? next.delete(id) : next.add(id)
      // If everything is selected again → back to null (cleaner)
      if([...allIds].every(i=>next.has(i))) return null
      return next
    })
  }
  // ── Edit mode helpers ──────────────────────────────────────────────────
  const startEdit = useCallback(rad => {
    // Find index in radiation array
    setRadiation(prev => {
      const idx = prev.findIndex(r => r === rad || (r.name===rad.name && r.pos.x===rad.pos.x && r.pos.z===rad.pos.z))
      setEditMode({ idx, draft: { ...rad, pos:{...rad.pos} } })
      setInspected(null)
      setSections(s=>({...s,info:true}))
      return prev
    })
  },[])

  const updateDraft = useCallback(patch => {
    setEditMode(prev => {
      if(!prev) return null
      const d = { ...prev.draft, ...patch }
      // Recalculate rt when intensity changes
      if(patch.intensityMax !== undefined || patch.intensityMin !== undefined) {
        d.rt = radTier(d.intensityMax)
      }
      return { ...prev, draft: d }
    })
  },[])

  const saveEdit = useCallback(() => {
    setEditMode(prev => {
      if(!prev) return null
      setRadiation(rads => rads.map((r,i) => i===prev.idx ? {...r,...prev.draft, rt:radTier(prev.draft.intensityMax)} : r))
      return null
    })
    showToast('Zone gespeichert ✓')
  },[showToast])

  const cancelEdit = useCallback(() => { setEditMode(null) },[])

  const exportRadiation = useCallback(() => {
    const exportArr = radiation.map(r => {
      const raw = {...(r.raw||{})}
      // Update fields in raw with current values
      const posStr = `${r.pos.x.toFixed(6)} 0 ${r.pos.z.toFixed(6)}`
      // Determine which position key the original used
      const posKey = Object.keys(raw).find(k=>['radiationcenter','radiationCenter','center','position'].includes(k.toLowerCase())) || 'radiationCenter'
      raw[posKey] = posStr
      // Update radius — use same key as original
      const radKey = Object.keys(raw).find(k=>['triggerradius','triggerRadius','radius','radiationradius','radiationRadius'].includes(k.toLowerCase())) || 'triggerRadius'
      raw[radKey] = r.radius
      raw.intensityMin = r.intensityMin
      raw.intensityMax = r.intensityMax
      return raw
    })
    const blob = new Blob([JSON.stringify(exportArr, null, 2)], {type:'application/json'})
    const a = document.createElement('a'); a.href=URL.createObjectURL(blob)
    a.download='RadiationZones_edited.json'; a.click()
    showToast('JSON exportiert')
  },[radiation, showToast])

  // ── Zone edit helpers ─────────────────────────────────────────────────
  const startZoneEdit = useCallback(zone => {
    setZones(prev => {
      const idx = prev.findIndex(z => z.name===zone.name && z.pos.x===zone.pos.x && z.pos.z===zone.pos.z)
      setZoneEdit({ idx, draft:{ name:zone.name, pos:{...zone.pos}, triggerRadius:zone.triggerRadius, despawnDistance:zone.despawnDistance } })
      setInspected(null)
      setSections(s=>({...s,info:true}))
      return prev
    })
  },[])

  const updateZoneDraft = useCallback(patch => {
    setZoneEdit(prev => prev ? {...prev, draft:{...prev.draft,...patch}} : null)
  },[])

  const saveZoneEdit = useCallback(() => {
    setZoneEdit(prev => {
      if(!prev) return null
      setZones(zs => zs.map((z,i) => i===prev.idx
        ? {...z, pos:{...prev.draft.pos}, triggerRadius:prev.draft.triggerRadius, despawnDistance:prev.draft.despawnDistance}
        : z
      ))
      return null
    })
    showToast('Zone gespeichert ✓')
  },[showToast])

  const cancelZoneEdit = useCallback(() => setZoneEdit(null),[])

  const exportZones = useCallback(() => {
    const exportArr = zones.map(z => ({
      name: z.name,
      enabled: z.enabled ? 1 : 0,
      position: `${z.pos.x.toFixed(6)} 0 ${z.pos.z.toFixed(6)}`,
      triggerRadius: z.triggerRadius,
      spawnChance: z.spawnChance,
      despawnDistance: z.despawnDistance,
      spawnPoints: z.spawnPoints.map(sp => ({
        position: `${sp.pos.x.toFixed(6)} 0 ${sp.pos.z.toFixed(6)}`,
        radius: sp.radius,
        tierIds: sp.tierIds.map(Number),
        entities: sp.entities,
        useFixedHeight: 1,
      })),
    }))
    const blob = new Blob([JSON.stringify(exportArr,null,2)],{type:'application/json'})
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob)
    a.download='Zones_edited.json'; a.click()
    showToast('Zones.json exportiert')
  },[zones,showToast])

  // ── Add radiation zone at world position ───────────────────────────────
  const addRadiationZone = useCallback((wx,wz) => {
    const auto = `RadZone_${String(radiation.length+1).padStart(3,'0')}`
    const newRad = {
      name: auto,
      pos: { x:+wx.toFixed(3), z:+wz.toFixed(3) },
      radius: 200,
      intensityMin: 10,
      intensityMax: 50,
      rt: radTier(50),
      raw: {
        name: auto,
        radiationCenter: `${wx.toFixed(6)} 20.000000 ${wz.toFixed(6)}`,
        triggerRadius: 200,
        intensityMin: 10,
        intensityMax: 50,
      },
    }
    setRadiation(prev => {
      const next = [...prev, newRad]
      // Open edit mode for the new zone immediately
      setEditMode({ idx: next.length-1, draft:{...newRad, pos:{...newRad.pos}} })
      setSections(s=>({...s,info:true}))
      return next
    })
    setCtxMenu(null)
    showToast(`${auto} hinzugefügt`)
  },[radiation, showToast])

  const toggleLayer = k => setLayers(l=>({...l,[k]:!l[k]}))
  const toggleSec   = k => setSections(s=>({...s,[k]:!s[k]}))
  const toggleRadFilter = tier => setRadFilter(prev=>{ const n=new Set(prev); n.has(tier)?n.delete(tier):n.add(tier); return n })

  const totalSpawnPoints = useMemo(()=>zones.reduce((s,z)=>s+z.spawnPoints.length,0),[zones])
  const visibleSPCount   = useMemo(()=>{
    if(!tierFilter) return totalSpawnPoints
    let c=0
    zones.forEach(z=>z.spawnPoints.forEach(sp=>{ if(sp.tierIds.some(id=>tierFilter.has(String(id)))) c++ }))
    return c
  },[zones,tierFilter,totalSpawnPoints])

  // ──────────────────────────────────────────────────────────────────
  // RENDER
  // ──────────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>

      {/* ═══ SIDEBAR ═══ */}
      <div style={S.sidebar}>
        <div style={S.logo}>
          <span style={S.logoT}>DAYZONE</span>
          <span style={S.logoS}>MAP ANALYZER v2.0</span>
        </div>

        {/* Import */}
        <div style={S.sideBlock}>
          <Lbl>Import</Lbl>
          {[
            {label:'Karte (PNG/JPG)',  type:'map',       accept:'image/*',   loaded:!!mapImg},
            {label:'Zones.json',       type:'zones',      accept:'.json',     loaded:zones.length>0},
            {label:'Tiers.json',       type:'tiers',      accept:'.json',     loaded:Object.keys(tiers).length>0},
            {label:'RadiationZones',   type:'radiation',  accept:'.json',     loaded:radiation.length>0},
            {label:'Anomalies.json',   type:'anomalies',  accept:'.json',     loaded:!!anomalies},
          ].map(({label,type,accept,loaded})=>(
            <label key={type} style={{display:'block',marginBottom:3,cursor:'pointer'}}>
              <input type="file" accept={accept} onChange={e=>onFile(e,type)} style={{display:'none'}}/>
              <div style={{padding:'5px 10px',borderRadius:3,fontSize:10,display:'flex',alignItems:'center',gap:6,
                border:`1px solid ${loaded?'#f97316':'#1a2030'}`,
                color:loaded?'#f97316':'#3d4a5e',
                background:loaded?'rgba(249,115,22,0.07)':'transparent'}}>
                <span style={{fontFamily:'monospace'}}>{loaded?'✓':'+'}</span>
                <span style={{flex:1}}>{label}</span>
              </div>
            </label>
          ))}
        </div>

        {/* Tool */}
        <div style={{display:'flex',gap:5,padding:'7px 12px',borderBottom:'1px solid #0d1521'}}>
          <TBtn active={tool==='pan'}    onClick={()=>setTool('pan')}>✋ Pan</TBtn>
          <TBtn active={tool==='select'} onClick={()=>setTool('select')}>⬚ Auswahl</TBtn>
        </div>
        {/* Unsaved edit indicator */}
        {(editMode||zoneEdit)&&(
          <div style={{padding:'3px 12px',background:'rgba(249,115,22,0.1)',borderBottom:'1px solid rgba(249,115,22,0.3)',fontSize:9,color:'#f97316',letterSpacing:1,display:'flex',alignItems:'center',gap:5}}>
            <span>●</span><span>Ungespeicherte Änderungen</span>
          </div>
        )}
        {selectedIds&&(
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'3px 12px',background:'#080d16',fontSize:10}}>
            <span style={{color:'#60a5fa'}}>{selectedIds.size} Zonen selektiert</span>
            <button style={S.xBtn} onClick={()=>setSelectedIds(null)}>✕</button>
          </div>
        )}

        {/* Scroll body */}
        <div style={S.scroll}>

          {/* ── Edit Mode Panel ── */}
          {editMode&&(()=>{
            const d = editMode.draft
            const c = d.rt.color
            return (
              <div style={{border:`1px solid ${c}`,borderRadius:4,margin:'0 0 6px',overflow:'hidden'}}>
                <div style={{background:hexA(c,0.15),padding:'7px 10px',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                  <span style={{fontSize:11,color:c,fontFamily:'monospace',letterSpacing:1}}>✏ EDIT: {d.name}</span>
                  <button onClick={cancelEdit} style={{background:'none',border:'none',color:c,cursor:'pointer',fontSize:11,fontFamily:'monospace'}}>✕</button>
                </div>
                <div style={{padding:'8px 10px',background:'#080e16'}}>
                  <div style={{fontSize:9,color:'#2a3040',marginBottom:8,padding:'4px 6px',border:'1px solid #0d1521',borderRadius:2}}>
                    ✋ Mittelpunkt auf Karte ziehen
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
                    <div style={{fontSize:9,color:'#3d4a5e'}}>X: <span style={{color:'#7a9ab0',fontFamily:'monospace'}}>{d.pos.x.toFixed(1)}</span></div>
                    <div style={{fontSize:9,color:'#3d4a5e'}}>Z: <span style={{color:'#7a9ab0',fontFamily:'monospace'}}>{d.pos.z.toFixed(1)}</span></div>
                  </div>
                  <div style={{marginBottom:10}}>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                      <span style={{fontSize:9,color:'#3d4a5e',letterSpacing:1}}>RADIUS</span>
                      <span style={{fontSize:10,color:c,fontFamily:'monospace'}}>{d.radius} m</span>
                    </div>
                    <input type="range" min="5" max="2000" step="5" value={d.radius}
                      onChange={e=>updateDraft({radius:+e.target.value})}
                      style={{width:'100%',accentColor:c,cursor:'pointer'}}/>
                    <div style={{display:'flex',justifyContent:'space-between',fontSize:8,color:'#1e2538',marginTop:2}}>
                      <span>5m</span><span>2000m</span>
                    </div>
                  </div>
                  <div style={{marginBottom:10}}>
                    <div style={{fontSize:9,color:'#3d4a5e',letterSpacing:1,marginBottom:6}}>INTENSITÄT (mSv)</div>
                    {[['Min',d.intensityMin,'intensityMin'],['Max',d.intensityMax,'intensityMax']].map(([lbl,val,key])=>(
                      <div key={key} style={{display:'flex',alignItems:'center',gap:5,marginBottom:5}}>
                        <span style={{fontSize:9,color:'#3d4a5e',minWidth:24}}>{lbl}</span>
                        <button onClick={()=>updateDraft({[key]:Math.max(0,val-10)})}
                          style={{width:22,height:22,background:'#0f1521',border:'1px solid #1a2030',color:'#4a5568',cursor:'pointer',borderRadius:2,fontFamily:'monospace',fontSize:13,lineHeight:1,padding:0}}>−</button>
                        <input type="number" value={val} min="0" max="9999"
                          onChange={e=>updateDraft({[key]:+e.target.value})}
                          style={{flex:1,background:'#0b1018',border:`1px solid ${hexA(c,0.3)}`,color:'#7a9ab0',fontFamily:'monospace',fontSize:10,padding:'2px 5px',borderRadius:2,textAlign:'center'}}/>
                        <button onClick={()=>updateDraft({[key]:val+10})}
                          style={{width:22,height:22,background:'#0f1521',border:'1px solid #1a2030',color:'#4a5568',cursor:'pointer',borderRadius:2,fontFamily:'monospace',fontSize:13,lineHeight:1,padding:0}}>+</button>
                      </div>
                    ))}
                    <div style={{padding:'3px 6px',borderRadius:2,background:hexA(d.rt.color,0.1),border:`1px solid ${hexA(d.rt.color,0.3)}`,fontSize:9,color:d.rt.color,marginTop:4}}>
                      → {d.rt.label}
                    </div>
                  </div>
                  <div style={{display:'flex',gap:5}}>
                    <button onClick={saveEdit} style={{flex:1,padding:'6px',background:'#22c55e',border:'none',borderRadius:3,color:'#000',fontSize:11,cursor:'pointer',fontFamily:'monospace',fontWeight:700}}>
                      ✓ Speichern
                    </button>
                    <button onClick={cancelEdit} style={{padding:'6px 10px',background:'#0f1521',border:'1px solid #1a2030',borderRadius:3,color:'#4a5568',fontSize:11,cursor:'pointer',fontFamily:'monospace'}}>
                      Abbrechen
                    </button>
                  </div>
                </div>
              </div>
            )
          })()}

          {/* ── Zone Edit Panel ── */}
          {zoneEdit&&(()=>{
            const d=zoneEdit.draft
            return (
              <div style={{border:'1px solid #94a3b8',borderRadius:4,margin:'0 0 6px',overflow:'hidden'}}>
                <div style={{background:'rgba(148,163,184,0.12)',padding:'7px 10px',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                  <span style={{fontSize:11,color:'#94a3b8',fontFamily:'monospace',letterSpacing:1}}>✏ ZONE: {d.name}</span>
                  <button onClick={cancelZoneEdit} style={{background:'none',border:'none',color:'#94a3b8',cursor:'pointer',fontSize:11,fontFamily:'monospace'}}>✕</button>
                </div>
                <div style={{padding:'8px 10px',background:'#080e16'}}>
                  <div style={{fontSize:9,color:'#2a3040',marginBottom:8,padding:'4px 6px',border:'1px solid #0d1521',borderRadius:2}}>
                    ✋ Mittelpunkt auf Karte ziehen
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
                    <div style={{fontSize:9,color:'#3d4a5e'}}>X: <span style={{color:'#7a9ab0',fontFamily:'monospace'}}>{d.pos.x.toFixed(1)}</span></div>
                    <div style={{fontSize:9,color:'#3d4a5e'}}>Z: <span style={{color:'#7a9ab0',fontFamily:'monospace'}}>{d.pos.z.toFixed(1)}</span></div>
                  </div>
                  {/* Trigger radius slider */}
                  {[
                    {key:'triggerRadius',  label:'TRIGGER-RADIUS',  val:d.triggerRadius,  min:1,  max:500,  step:1,  col:'#94a3b8'},
                    {key:'despawnDistance',label:'DESPAWN-RADIUS',  val:d.despawnDistance,min:10, max:2000, step:10, col:'#facc15'},
                  ].map(({key,label,val,min,max,step,col})=>(
                    <div key={key} style={{marginBottom:10}}>
                      <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                        <span style={{fontSize:9,color:'#3d4a5e',letterSpacing:1}}>{label}</span>
                        <span style={{fontSize:10,color:col,fontFamily:'monospace'}}>{val} m</span>
                      </div>
                      <input type="range" min={min} max={max} step={step} value={val}
                        onChange={e=>updateZoneDraft({[key]:+e.target.value})}
                        style={{width:'100%',accentColor:col,cursor:'pointer'}}/>
                      <div style={{display:'flex',justifyContent:'space-between',fontSize:8,color:'#1e2538',marginTop:2}}>
                        <span>{min}m</span><span>{max}m</span>
                      </div>
                    </div>
                  ))}
                  <div style={{display:'flex',gap:5}}>
                    <button onClick={saveZoneEdit} style={{flex:1,padding:'6px',background:'#4ade80',border:'none',borderRadius:3,color:'#000',fontSize:11,cursor:'pointer',fontFamily:'monospace',fontWeight:700}}>
                      ✓ Speichern
                    </button>
                    <button onClick={cancelZoneEdit} style={{padding:'6px 10px',background:'#0f1521',border:'1px solid #1a2030',borderRadius:3,color:'#4a5568',fontSize:11,cursor:'pointer',fontFamily:'monospace'}}>
                      Abbrechen
                    </button>
                  </div>
                </div>
              </div>
            )
          })()}

          {/* Info Panel — renders for zone / radiation / anomaly */}
          {inspected&&(()=>{
            const {type,data:d} = inspected
            const typeLabel = type==='zone'?'🧟 Spawn-Zone':type==='radiation'?'☢️ Radiation':type==='statAnom'?'⚡ Statische Anomalie':type==='dynAnom'?'⚡ Dynamisches Feld':'⚡ Teleport'
            const pos = d.pos
            return (
              <Coll title={`📍  ${typeLabel}`} open={sections.info} onToggle={()=>toggleSec('info')}>
                <IRow label="Name" val={d.name||d.Name||'–'}/>
                {pos&&<>
                  <IRow label="X / Z"    val={`${pos.x.toFixed(2)} / ${pos.z.toFixed(2)}`}/>
                  <IRow label="Position" val={`${pos.x.toFixed(1)} 0 ${pos.z.toFixed(1)}`}/>
                </>}

                {/* Spawn Zone */}
                {type==='zone'&&<>
                  <IRow label="TriggerR"    val={`${d.triggerRadius} m`}/>
                  <IRow label="DespawnR"    val={`${d.despawnDistance} m`}/>
                  <IRow label="SpawnPoints" val={d.spawnPoints.length}/>
                  <button onClick={()=>startZoneEdit(d)} style={{marginTop:8,marginBottom:6,width:'100%',padding:'5px',background:'#1a2030',border:'1px solid #94a3b8',borderRadius:3,color:'#94a3b8',fontSize:11,cursor:'pointer',fontFamily:'monospace',letterSpacing:1}}>
                    ✏ ZONE BEARBEITEN
                  </button>
                  {d.spawnPoints.length>0&&<>
                    <div style={S.miniLbl}>SPAWN-PUNKTE ({d.spawnPoints.length})</div>
                    <div style={{maxHeight:150,overflowY:'auto',borderLeft:'2px solid #1a2030',paddingLeft:6}}>
                      {d.spawnPoints.map((sp,i)=>{
                        const tierNames=sp.tierIds.map(id=>tiers[id]?.name||`T${id}`).join(', ')
                        return (
                          <div key={i} style={{marginBottom:5,paddingBottom:4,borderBottom:'1px solid #0d1521'}}>
                            <div style={{display:'flex',alignItems:'center',gap:4,marginBottom:2,flexWrap:'wrap'}}>
                              {sp.tierIds.map(id=>(
                                <span key={id} style={{width:7,height:7,borderRadius:'50%',background:tcol(id),display:'inline-block',flexShrink:0}}/>
                              ))}
                              <span style={{fontSize:9,color:'#5a7080',fontFamily:'monospace'}}>{tierNames}</span>
                            </div>
                            <div style={{fontSize:9,color:'#3d4a5e',fontFamily:'monospace'}}>
                              X:{sp.pos.x.toFixed(1)} Z:{sp.pos.z.toFixed(1)} r:{sp.radius}m e:{sp.entities}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </>}
                </>}

                {/* Radiation Zone */}
                {type==='radiation'&&<>
                  <IRow label="Radius"      val={`${d.radius} m`}/>
                  <IRow label="Min Intensität" val={`${d.intensityMin} mSv`}/>
                  <IRow label="Max Intensität" val={`${d.intensityMax} mSv`}/>
                  <IRow label="Stufe"       val={d.rt?.label||'–'} />
                  <div style={{marginTop:6,padding:'4px 6px',borderRadius:2,background:hexA(d.rt?.color||'#22c55e',0.12),border:`1px solid ${hexA(d.rt?.color||'#22c55e',0.3)}`,fontSize:10,color:d.rt?.color||'#22c55e'}}>
                    {d.rt?.tier===1?'Tier-1 Maske ausreichend':d.rt?.tier===2?'Tier-2 Maske erforderlich':'Tier-3 Maske erforderlich'}
                  </div>
                  <button onClick={()=>startEdit(d)} style={{marginTop:8,width:'100%',padding:'5px',background:'#1a2030',border:'1px solid #f97316',borderRadius:3,color:'#f97316',fontSize:11,cursor:'pointer',fontFamily:'monospace',letterSpacing:1}}>
                    ✏ ZONE BEARBEITEN
                  </button>
                </>}

                {/* Static Anomaly */}
                {type==='statAnom'&&<>
                  <IRow label="Tier"  val={d.tier||d.Tier||'–'}/>
                  <IRow label="Type"  val={d.type||d.anomalyType||'–'}/>
                </>}

                {/* Dynamic Anomaly Field */}
                {type==='dynAnom'&&<>
                  <IRow label="Radius"    val={`${d.radius||150} m`}/>
                  <IRow label="Anomalien" val={(d.Anomalies||d.anomalies||[]).length}/>
                </>}

                {/* Teleport */}
                {type==='teleport'&&<>
                  <IRow label="Von" val={d.position_by||d.positionBy||d.from||'–'}/>
                  <IRow label="Nach" val={d.position_to||d.positionTo||d.to||'–'}/>
                </>}

                <button style={{...S.xBtn,display:'block',marginTop:8,padding:'3px 8px',background:'#111824',border:'1px solid #1a2030',borderRadius:2}}
                  onClick={()=>setInspected(null)}>✕ Schließen</button>
              </Coll>
            )
          })()}

          {/* Mutanten */}
          <Coll title="🧟  Mutanten" open={sections.mutants} onToggle={()=>toggleSec('mutants')}>
            <Tog label="Trigger-Radius"  on={layers.triggerRadius}  onChange={()=>toggleLayer('triggerRadius')}  col="#94a3b8"/>
            <Tog label="Despawn-Radius"  on={layers.despawnRadius}  onChange={()=>toggleLayer('despawnRadius')}  col="#facc15"/>
            <Tog label="SpawnPoints"     on={layers.spawnPoints}    onChange={()=>toggleLayer('spawnPoints')}    col="#60a5fa"/>
            <Tog label="Spawn-Radius"    on={layers.spawnRadius}    onChange={()=>toggleLayer('spawnRadius')}    col="#f97316"/>
            <Tog label="Zonen-Namen"     on={layers.zoneNames}      onChange={()=>toggleLayer('zoneNames')}      col="#c4b5fd"/>

            {/* Tier filter */}
            {visibleTiers.length>0&&<>
              <div style={S.miniLbl}>Tier-Filter</div>
              <div style={{display:'flex',gap:4,marginBottom:6}}>
                <FBtn onClick={()=>setTierFilter(null)}>Alle ein</FBtn>
                <FBtn onClick={()=>setTierFilter(new Set())}>Alle aus</FBtn>
              </div>
              <div style={{maxHeight:220,overflowY:'auto'}}>
                {visibleTiers.map(t=>{
                  const on = !tierFilter||tierFilter.has(t.id)
                  return (
                    <div key={t.id} onClick={()=>toggleTier(t.id)} style={{
                      display:'flex',alignItems:'center',gap:6,padding:'3px 5px',
                      cursor:'pointer',borderRadius:2,marginBottom:1,userSelect:'none',
                      background:on?'#0e1824':'transparent',
                    }}>
                      <div style={{width:13,height:13,borderRadius:2,flexShrink:0,
                        border:`1.5px solid ${on?t.color:'#2a3040'}`,
                        background:on?t.color:'transparent',
                        display:'flex',alignItems:'center',justifyContent:'center'}}>
                        {on&&<span style={{fontSize:8,color:'#000',fontWeight:900,lineHeight:1}}>✓</span>}
                      </div>
                      <div style={{width:7,height:7,borderRadius:'50%',background:on?t.color:'#2a3040',flexShrink:0}}/>
                      <span style={{fontSize:10,flex:1,color:on?'#c8d4e0':'#3d4a5e',fontFamily:'monospace'}}>
                        <span style={{color:'#3d4a5e',fontSize:9}}>{t.id} </span>{t.name}
                      </span>
                      <span style={{fontSize:9,color:'#2a3040'}}>{spCountByTier[t.id]||0}</span>
                    </div>
                  )
                })}
              </div>
            </>}
            <div style={{display:'flex',gap:5,marginBottom:4}}>
              <button onClick={exportZones} style={{flex:1,padding:'5px',background:'#0f1521',border:'1px solid #4ade80',borderRadius:3,color:'#4ade80',fontSize:10,cursor:'pointer',fontFamily:'monospace'}}>
                ↓ Zones.json exportieren
              </button>
            </div>
            <div style={S.stat}>
              {visibleSPCount}/{totalSpawnPoints} SpawnPts · {zones.length} Zonen
            </div>
          </Coll>

          {/* Strahlung */}
          <Coll title="☢️  Strahlung" open={sections.rad} onToggle={()=>toggleSec('rad')}>
            <Tog label="Strahlungszonen" on={layers.radiation} onChange={()=>toggleLayer('radiation')} col="#22c55e"/>
            <div style={S.miniLbl}>Intensitäts-Filter</div>
            {[{tier:1,label:'Tier 1 ≤150 mSv',color:'#22c55e'},{tier:2,label:'Tier 2 ≤350 mSv',color:'#f59e0b'},{tier:3,label:'Tier 3 >350 mSv',color:'#ef4444'}].map(rt=>{
              const on=radFilter.has(rt.tier)
              const cnt=radiation.filter(r=>r.rt.tier===rt.tier).length
              return (
                <div key={rt.tier} onClick={()=>toggleRadFilter(rt.tier)} style={{
                  display:'flex',alignItems:'center',gap:6,padding:'3px 5px',cursor:'pointer',borderRadius:2,marginBottom:2,userSelect:'none',
                  background:on?'#0e1824':'transparent'}}>
                  <div style={{width:13,height:13,borderRadius:2,flexShrink:0,
                    border:`1.5px solid ${on?rt.color:'#2a3040'}`,background:on?rt.color:'transparent',
                    display:'flex',alignItems:'center',justifyContent:'center'}}>
                    {on&&<span style={{fontSize:8,color:'#000',fontWeight:900}}>✓</span>}
                  </div>
                  <div style={{width:7,height:7,borderRadius:'50%',background:on?rt.color:'#2a3040',flexShrink:0}}/>
                  <span style={{fontSize:10,flex:1,color:on?'#c8d4e0':'#3d4a5e'}}>{rt.label}</span>
                  <span style={{fontSize:9,color:'#2a3040'}}>{cnt}</span>
                </div>
              )
            })}
            <div style={{display:'flex',gap:5,marginBottom:6}}>
              <button onClick={exportRadiation} style={{flex:1,padding:'5px',background:'#0f1521',border:'1px solid #22c55e',borderRadius:3,color:'#22c55e',fontSize:10,cursor:'pointer',fontFamily:'monospace'}}>
                ↓ JSON exportieren
              </button>
            </div>
            <div style={S.stat}>{radiation.length} Zonen geladen</div>
          </Coll>

          {/* Anomalien */}
          <Coll title="⚡  Anomalien" open={sections.anom} onToggle={()=>toggleSec('anom')}>
            <Tog label="Teleports"         on={layers.teleports} onChange={()=>toggleLayer('teleports')} col="#a855f7"/>
            <Tog label="Dynamische Felder" on={layers.dynAnom}   onChange={()=>toggleLayer('dynAnom')}   col="#f59e0b"/>
            <Tog label="Statische Anom."   on={layers.statAnom}  onChange={()=>toggleLayer('statAnom')}  col="#60a5fa"/>
            {anomalies&&<div style={S.stat}>{(anomalies.Teleports||[]).length}T · {(anomalies.AnomaliesDynamic||[]).length}D · {(anomalies.AnomaliesStatic||[]).length}S</div>}
          </Coll>

          {/* Stashes */}
          <Coll title="📦  Stashes" open={sections.stashes} onToggle={()=>toggleSec('stashes')}>
            <div style={{...S.stat,fontStyle:'italic'}}>In Vorbereitung (.dze)</div>
          </Coll>
        </div>

        <div style={S.footer}>
          <div style={S.hint}>Klick → Zone inspizieren</div>
          <div style={S.hint}>Doppelklick → Info-Panel öffnen</div>
        </div>
      </div>

      {/* ═══ MAP ═══ */}
      <div ref={containerRef} style={{flex:1,position:'relative',overflow:'hidden',cursor:(editMode||zoneEdit)?'move':tool==='select'?'crosshair':ctxMenu?'default':'grab'}}>
        <canvas ref={canvasRef} style={{display:'block',width:'100%',height:'100%'}}
          onMouseDown={onCanvasMouseDown}
          onMouseMove={onCanvasMouseMove}/>

        <div style={S.coordHud}>X: {cursor.x.toFixed(1)} &nbsp;|&nbsp; Z: {cursor.z.toFixed(1)}</div>
        <div style={S.zoomHud}>{zoomPct}%</div>
        <button onClick={centerMap} style={S.centerBtn} title="Zentrieren">⊡</button>

        {/* Shift+LMB context menu */}
        {ctxMenu&&(
          <div style={{position:'absolute',top:ctxMenu.cy+8,left:ctxMenu.cx+8,background:'#0c1118',border:'1px solid #1a2030',borderRadius:5,overflow:'hidden',zIndex:50,minWidth:180,boxShadow:'0 4px 20px rgba(0,0,0,0.7)'}}>
            <div style={{padding:'5px 10px',fontSize:9,color:'#2a3040',borderBottom:'1px solid #0d1521',letterSpacing:1}}>
              X:{ctxMenu.wx.toFixed(1)} Z:{ctxMenu.wz.toFixed(1)}
            </div>
            <div style={{padding:'4px 0'}}>
              <div onClick={()=>addRadiationZone(ctxMenu.wx,ctxMenu.wz)}
                style={{padding:'7px 12px',fontSize:11,color:'#22c55e',cursor:'pointer',display:'flex',alignItems:'center',gap:7,fontFamily:'monospace'}}
                onMouseEnter={e=>e.currentTarget.style.background='#111c14'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <span>☢</span><span>Strahlungszone hinzufügen</span>
              </div>
            </div>
            <div style={{padding:'4px 10px 6px',borderTop:'1px solid #0d1521'}}>
              <button onClick={()=>setCtxMenu(null)}
                style={{width:'100%',padding:'3px',background:'none',border:'none',color:'#2a3040',fontSize:9,cursor:'pointer',fontFamily:'monospace'}}>
                Abbrechen
              </button>
            </div>
          </div>
        )}
        {/* Click away to close context menu */}
        {ctxMenu&&<div style={{position:'absolute',inset:0,zIndex:49}} onClick={()=>setCtxMenu(null)}/>}

        {!mapImg&&(
          <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',textAlign:'center',pointerEvents:'none'}}>
            <div style={{fontSize:38,opacity:.15,marginBottom:8}}>🗺️</div>
            <div style={{color:'#1a2030',fontSize:12,letterSpacing:1}}>Karte über die Sidebar importieren</div>
          </div>
        )}
        {toast&&<div style={{...S.toast,background:toast.type==='error'?'#ef4444':'#f97316'}}>{toast.msg}</div>}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════════════
function Coll({title,open,onToggle,children}){
  return (
    <div style={{marginBottom:2}}>
      <div onClick={onToggle} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'7px 8px',cursor:'pointer',background:'#0c1018',borderRadius:3,marginBottom:1,userSelect:'none'}}>
        <span style={{fontSize:11,letterSpacing:.8,color:'#5a6a7a'}}>{title}</span>
        <span style={{fontSize:9,color:'#2a3040'}}>{open?'▾':'▸'}</span>
      </div>
      {open&&<div style={{padding:'4px 8px 10px'}}>{children}</div>}
    </div>
  )
}
function Tog({label,on,onChange,col}){
  return (
    <div onClick={onChange} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'3px 2px',cursor:'pointer',borderRadius:2,marginBottom:3,userSelect:'none'}}>
      <div style={{display:'flex',alignItems:'center',gap:6}}>
        <div style={{width:7,height:7,borderRadius:'50%',background:on?col:'#2a3040',flexShrink:0}}/>
        <span style={{fontSize:11,color:on?'#c8d4e0':'#3d4a5e'}}>{label}</span>
      </div>
      <div style={{width:28,height:14,borderRadius:7,position:'relative',background:on?'#f97316':'#141c28',border:`1px solid ${on?'#f97316':'#1a2030'}`}}>
        <div style={{width:10,height:10,borderRadius:'50%',position:'absolute',top:1,background:on?'#fff':'#3d4a5e',left:on?15:1,transition:'left .15s'}}/>
      </div>
    </div>
  )
}
function IRow({label,val}){
  return (
    <div style={{display:'flex',justifyContent:'space-between',padding:'2px 0',borderBottom:'1px solid #0d1521',marginBottom:1}}>
      <span style={{fontSize:9,color:'#2a3040',minWidth:72}}>{label}</span>
      <span style={{fontSize:10,color:'#5a8090',fontFamily:'monospace',textAlign:'right',wordBreak:'break-all'}}>{val}</span>
    </div>
  )
}
function TBtn({active,onClick,children}){
  return <button onClick={onClick} style={{flex:1,padding:'5px 3px',border:'none',borderRadius:3,cursor:'pointer',fontSize:10,fontFamily:'monospace',background:active?'#f97316':'#111824',color:active?'#000':'#4a5568'}}>{children}</button>
}
function FBtn({onClick,children}){
  return <button onClick={onClick} style={{flex:1,padding:'3px',background:'#0c1018',border:'1px solid #1a2030',color:'#3d4a5e',fontSize:10,cursor:'pointer',fontFamily:'monospace',borderRadius:2}}>{children}</button>
}
function Lbl({children}){
  return <div style={{fontSize:9,color:'#1a2030',letterSpacing:2,textTransform:'uppercase',marginBottom:6}}>{children}</div>
}

// ═══════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════
const S={
  root:     {display:'flex',height:'100vh',background:'#07090d',color:'#e2e8f0',fontFamily:"'Courier New',monospace",overflow:'hidden'},
  sidebar:  {width:274,minWidth:274,background:'#090d14',borderRight:'1px solid #0d1521',display:'flex',flexDirection:'column',overflow:'hidden',userSelect:'none'},
  logo:     {padding:'13px 14px 11px',borderBottom:'1px solid #0d1521',background:'#050810',display:'flex',flexDirection:'column',gap:3},
  logoT:    {fontSize:16,fontWeight:700,color:'#f97316',letterSpacing:4},
  logoS:    {fontSize:9,color:'#1a2030',letterSpacing:2},
  sideBlock:{padding:'10px 12px',borderBottom:'1px solid #0d1521'},
  scroll:   {flex:1,overflowY:'auto',padding:'5px'},
  miniLbl:  {fontSize:9,color:'#1a2030',letterSpacing:2,textTransform:'uppercase',marginTop:10,marginBottom:5},
  stat:     {fontSize:10,color:'#2a3040',marginTop:5,padding:'0 2px'},
  footer:   {padding:'8px 12px',borderTop:'1px solid #0d1521'},
  hint:     {fontSize:9,color:'#1a2030',marginBottom:2},
  xBtn:     {background:'none',border:'none',color:'#3d4a5e',cursor:'pointer',fontSize:10,fontFamily:'monospace'},
  coordHud: {position:'absolute',bottom:12,left:12,background:'rgba(5,8,13,0.92)',border:'1px solid #0d1521',padding:'4px 12px',borderRadius:3,fontSize:11,color:'#4a5568',letterSpacing:.5,pointerEvents:'none'},
  zoomHud:  {position:'absolute',bottom:12,right:54,background:'rgba(5,8,13,0.92)',border:'1px solid #0d1521',padding:'4px 10px',borderRadius:3,fontSize:10,color:'#2a3040',pointerEvents:'none'},
  centerBtn:{position:'absolute',bottom:8,right:10,width:34,height:34,background:'rgba(5,8,13,0.92)',border:'1px solid #1a2030',color:'#3d4a5e',cursor:'pointer',fontSize:17,borderRadius:3,lineHeight:'34px',textAlign:'center',padding:0},
  toast:    {position:'absolute',top:14,left:'50%',transform:'translateX(-50%)',color:'#000',padding:'5px 18px',borderRadius:4,fontSize:11,fontWeight:700,fontFamily:'monospace',letterSpacing:.5,whiteSpace:'nowrap',zIndex:99},
}
