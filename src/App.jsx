import { useState, useEffect, useRef } from 'react';
import './index.css'; 

function App() {
  // --- [상태 관리] ---
  const [isRunning, setIsRunning] = useState(false);
  const [statusText, setStatusText] = useState("System Standby");
  const [logs, setLogs] = useState([]);
  const [detectedStudents, setDetectedStudents] = useState({});
  const [showList, setShowList] = useState(false);

  // AI & 센서 상태
  const [audioLabel, setAudioLabel] = useState("Standby");
  const [audioScore, setAudioScore] = useState(0);
  const [videoState, setVideoState] = useState("Closed");
  const [videoGap, setVideoGap] = useState(0);

  // --- [설정값] ---
  const CONFIG = {
    confidence: 0.5,    // AI 신뢰도 50%
    mouthOpen: 0.004,   // 입벌림 민감도 (4%)
    lipMovement: 0.002, // 입 움직임 민감도
    strictness: 3       // 적발 기준 프레임
  };

  // --- [내부 변수] ---
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const classifierRef = useRef(null);
  const audioCtxRef = useRef(null);
  const lipHistory = useRef([]);
  const violationQueue = useRef([]);
  const dbRef = useRef(null);
  const alertTimeout = useRef(null);

  // --- [초기화: 파이어베이스] ---
  useEffect(() => {
    if (window.firebase && !dbRef.current) {
      const config = {
        apiKey: "AIzaSyDaLlrTKsMCpCzVgBW9icTmEPcuO_zoWVY",
        authDomain: "acdt-project.firebaseapp.com",
        projectId: "acdt-project",
        storageBucket: "acdt-project.firebasestorage.app",
        messagingSenderId: "243281762920",
        appId: "1:243281762920:web:6641d9eadfe1e93442f9dd",
        measurementId: "G-J9TVZXN3LE"
      };
      if (!window.firebase.apps.length) window.firebase.initializeApp(config);
      dbRef.current = window.firebase.firestore();
      
      // 명단 실시간 로드
      dbRef.current.collection("detections").orderBy("timestamp", "desc")
        .onSnapshot(snap => {
          const st = {};
          snap.forEach(doc => {
            const d = doc.data();
            if (!st[d.studentId]) st[d.studentId] = { name: d.name, id: d.studentId, records: [] };
            st[d.studentId].records.push(d.timestamp ? new Date(d.timestamp.toDate()).toLocaleTimeString() : "-");
          });
          setDetectedStudents(st);
        });
    }
  }, []);

  // --- [핵심 로직: 시작] ---
  const startSystem = async () => {
    const name = document.getElementById('inp-name').value;
    const id = document.getElementById('inp-id').value;
    if (!name || !id) { alert("Input Name & ID"); return; }

    setStatusText("Initializing...");
    try {
      // 1. AI 로드
      const cls = new window.EdgeImpulseClassifier();
      await cls.init();
      classifierRef.current = cls;

      // 2. 오디오/비디오 시작
      await startAudio();
      await startVideo();

      setIsRunning(true);
      setStatusText("Monitoring Active 🟢");
    } catch (e) {
      alert("Error: " + e.message);
      window.location.reload();
    }
  };

  // --- [로직: 오디오] ---
  const startAudio = async () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    audioCtxRef.current = ctx;
    if (ctx.state === 'suspended') await ctx.resume();

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    
    // 버퍼 처리 (주파수 변환)
    const targetRate = 16000;
    const bufferSize = 16000;
    let circBuffer = new Float32Array(bufferSize);
    let wIdx = 0;

    src.connect(proc);
    proc.connect(ctx.destination);

    proc.onaudioprocess = (e) => {
      if (!classifierRef.current) return;
      const input = e.inputBuffer.getChannelData(0);
      
      // 다운샘플링 (44.1kHz -> 16kHz)
      let rateRatio = ctx.sampleRate / targetRate;
      let newLen = Math.round(input.length / rateRatio);
      let res = new Float32Array(newLen);
      let offRes = 0, offBuf = 0;
      while (offRes < newLen) {
        let nextOff = Math.round((offRes + 1) * rateRatio);
        let accum = 0, count = 0;
        for (let i = offBuf; i < nextOff && i < input.length; i++) { accum += input[i]; count++; }
        res[offRes] = accum / count;
        offRes++; offBuf = nextOff;
      }

      for (let i = 0; i < res.length; i++) {
        circBuffer[wIdx] = res[i];
        wIdx = (wIdx + 1) % bufferSize;
      }

      // 분류 실행
      let linear = new Float32Array(bufferSize);
      for (let i = 0; i < bufferSize; i++) linear[i] = circBuffer[(wIdx + i) % bufferSize];

      try {
        let ret = classifierRef.current.classify(linear);
        let top = ret.results.reduce((p, c) => p.value > c.value ? p : c);
        setAudioLabel(top.label);
        setAudioScore(top.value);
      } catch (ex) {}
    };
  };

  // --- [로직: 비디오] ---
  const startVideo = async () => {
    const vid = document.getElementById('hidden-video');
    const cvs = canvasRef.current;
    const ctx = cvs.getContext('2d');

    const faceMesh = new window.FaceMesh({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
    faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5 });

    faceMesh.onResults((res) => {
      cvs.width = 500; cvs.height = 500;
      ctx.fillStyle = "black"; ctx.fillRect(0, 0, 500, 500);

      let state = "Closed";
      
      if (res.image && res.multiFaceLandmarks.length > 0) {
        const lm = res.multiFaceLandmarks[0];
        const sW = vid.videoWidth; const sH = vid.videoHeight;
        const up = lm[13]; const low = lm[14];

        // 줌 그리기
        const zoom = 4.0; 
        const cw = sW/zoom; const ch = sH/zoom;
        let cx = ((up.x + low.x)/2 * sW) - cw/2;
        let cy = ((up.y + low.y)/2 * sH) - ch/2;
        ctx.drawImage(res.image, cx, cy, cw, ch, 0, 0, 500, 500);

        // 로직
        const gap = low.y - up.y;
        setVideoGap(Math.round((gap/0.05)*100));
        
        lipHistory.current.push(gap);
        if (lipHistory.current.length > 5) lipHistory.current.shift();
        
        // 표준편차 계산
        const mean = lipHistory.current.reduce((a,b)=>a+b,0)/lipHistory.current.length;
        const move = Math.sqrt(lipHistory.current.reduce((a,b)=>a+Math.pow(b-mean,2),0)/lipHistory.current.length);

        if (gap > CONFIG.mouthOpen) {
          state = move > CONFIG.lipMovement ? "Speaking" : "Open";
        }
        
        checkViolation(state);
      }
      setVideoState(state);
    });

    const camera = new window.Camera(vid, {
      onFrame: async () => { await faceMesh.send({ image: vid }); },
      width: 1280, height: 720
    });
    await camera.start();
  };

  // --- [판정 로직] ---
  const checkViolation = (vState) => {
    // 오디오는 State값 참조 (React 방식)
    // 실제로는 Ref를 쓰는게 더 정확하지만, 간단한 구현을 위해 State 사용
    const isKorean = audioLabel === 'korean' && audioScore > CONFIG.confidence;
    const isMouth = vState === "Speaking";

    if (isKorean && isMouth) violationQueue.current.push(1);
    else violationQueue.current.push(0);
    
    if (violationQueue.current.length > 10) violationQueue.current.shift();
    const cnt = violationQueue.current.filter(v => v === 1).length;

    if (cnt >= CONFIG.strictness) {
      doAlert();
    }
  };

  const doAlert = () => {
    if (alertTimeout.current) return;
    
    // UI 변경
    const img = document.getElementById('monitor-img');
    const overlay = document.getElementById('overlay-alert');
    if (img) { img.src = "2.jpg"; img.classList.add('alert'); }
    if (overlay) overlay.style.display = 'block';

    // DB 저장
    const n = document.getElementById('inp-name').value;
    const i = document.getElementById('inp-id').value;
    if (dbRef.current) {
      dbRef.current.collection("detections").add({
        name: n, studentId: i, reason: "KOREAN", timestamp: window.firebase.firestore.FieldValue.serverTimestamp()
      });
    }

    // 3초 후 리셋
    alertTimeout.current = setTimeout(() => {
      if (img) { img.src = "1.jpg"; img.classList.remove('alert'); }
      if (overlay) overlay.style.display = 'none';
      alertTimeout.current = null;
      violationQueue.current = [];
    }, 3000);
  };

  // --- [화면 그리기] ---
  return (
    <div className="app-container">
      {/* 1. 사이드바 */}
      <div id="sidebar">
        <div className="title"><h2>KOREAN KILLER</h2><div className="logo">KK</div></div>
        <input id="inp-name" type="text" placeholder="Name" />
        <input id="inp-id" type="text" placeholder="ID" />
        
        {!isRunning ? 
          <button className="btn-start" onClick={startSystem}>▶ Start</button> : 
          <button className="btn-stop" onClick={()=>window.location.reload()}>⏹ Stop</button>
        }
        
        <button className="btn-blue" onClick={() => setShowList(!showList)}>📋 List</button>
        <button className="btn-gray" onClick={() => {
           if(prompt("PW")==="kyj") { 
             document.getElementById('prof-area').style.display='block'; 
           }
        }}>🔒 Admin</button>

        <div id="prof-area" style={{display:'none', marginTop:'10px', borderTop:'1px solid #555', paddingTop:'10px'}}>
           <p style={{color:'orange', margin:0}}>Admin Mode</p>
           <button className="btn-red" onClick={async ()=>{
             if(confirm("DELETE ALL?")) {
               const s = await dbRef.current.collection("detections").get();
               const b = dbRef.current.batch();
               s.docs.forEach(d=>b.delete(d.ref));
               await b.commit();
             }
           }}>⚠️ Reset DB</button>
        </div>
      </div>

      {/* 2. 명단 패널 (숨김/표시) */}
      <div id="list-panel" className={showList ? 'open' : ''}>
        <h3>🚨 Detections</h3>
        <ul>
          {Object.values(detectedStudents).map(s => (
            <li key={s.id} className={s.records.length > 3 ? 'bad' : ''}>
              <b>{s.name}</b> ({s.id}) <span className="badge">{s.records.length}</span>
              <div className="times">{s.records.map((t,i)=><div key={i}>{t}</div>)}</div>
            </li>
          ))}
        </ul>
      </div>

      {/* 3. 메인 화면 */}
      <div id="main-content">
        {/* 왼쪽: 이미지 */}
        <img id="monitor-img" src="1.jpg" alt="Monitor" />

        {/* 오른쪽: 줌 카메라 */}
        <div id="center-stage">
          {!isRunning && <div className="placeholder"><h1>Ready</h1><p>Enter info & Start</p></div>}
          
          <div id="cam-box" style={{display: isRunning ? 'block' : 'none'}}>
            <canvas ref={canvasRef} id="output_canvas"></canvas>
            <div id="overlay-alert">🚨 DETECTED!</div>
          </div>

          {/* 상태 표시 (중앙 하단) */}
          {isRunning && (
            <div className="status-bar">
              <span className={audioLabel === 'korean' && audioScore > CONFIG.confidence ? 'red' : ''}>
                🎤 {audioLabel.toUpperCase()} {Math.round(audioScore*100)}%
              </span>
              <span className={videoState === 'Speaking' ? 'green' : ''}>
                👄 {videoState} {videoGap}%
              </span>
            </div>
          )}
        </div>
      </div>

      {/* 숨겨진 비디오 태그 */}
      <video id="hidden-video" ref={videoRef} playsInline autoPlay style={{display:'none'}}></video>
    </div>
  );
}

export default App;
