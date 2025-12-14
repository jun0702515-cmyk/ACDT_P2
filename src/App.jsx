import { useState, useEffect, useRef } from 'react';
import './index.css'; 

function App() {
  const dbRef = useRef(null);
  
  // AI 및 센서 관련 변수
  const classifierRef = useRef(null);
  const audioCtxRef = useRef(null);
  
  // 로직 상태 변수
  const [isRunning, setIsRunning] = useState(false);
  const lastKoreanTime = useRef(0);
  const lastMouthTime = useRef(0);
  const lastTriggerTime = useRef(0);
  const alertTimeout = useRef(null);

  // 화면 표시용 상태 (Standby -> Listening)
  const [micStatus, setMicStatus] = useState("🎤 Standby");
  const [micClass, setMicClass] = useState("status-box");

  // [1] 초기화: 파이어베이스 연결
  useEffect(() => {
    if (window.firebase && !dbRef.current) {
      const firebaseConfig = {
        apiKey: "AIzaSyDaLlrTKsMCpCzVgBW9icTmEPcuO_zoWVY",
        authDomain: "acdt-project.firebaseapp.com",
        projectId: "acdt-project",
        storageBucket: "acdt-project.firebasestorage.app",
        messagingSenderId: "243281762920",
        appId: "1:243281762920:web:6641d9eadfe1e93442f9dd",
        measurementId: "G-J9TVZXN3LE"
      };
      if (!window.firebase.apps.length) window.firebase.initializeApp(firebaseConfig);
      dbRef.current = window.firebase.firestore();
      loadList();
    }
  }, []);

  // [2] 시스템 시작
  const startSystem = async () => {
    const name = document.getElementById('input-name').value;
    const id = document.getElementById('input-id').value;
    if (!name || !id) { alert("Please enter Name and Student ID!"); return; }

    const btn = document.getElementById('btn-start');
    const msg = document.getElementById('loading-msg');
    
    if(btn) btn.disabled = true;
    if(msg) { msg.style.display = 'block'; msg.innerText = "Starting AI..."; }

    try {
      // (1) AI 로드
      if (!classifierRef.current) {
          const classifier = new window.EdgeImpulseClassifier();
          await classifier.init();
          classifierRef.current = classifier;
      }

      // (2) 오디오 시작 (가장 중요: 순서 변경)
      await startAudioProcessing();

      // (3) 비디오 시작
      await startFaceMesh();

      // UI 전환
      if(msg) msg.style.display = 'none';
      if(btn) btn.style.display = 'none';
      
      document.getElementById('btn-stop').style.display = 'block';
      document.getElementById('placeholder').style.display = 'none';
      document.getElementById('camera-wrapper').style.display = 'block';
      document.getElementById('status-panel').style.display = 'flex';
      
      // 상태 강제 변경 (Listening...)
      setMicStatus("🎤 Listening...");
      setIsRunning(true);

    } catch (err) {
      console.error(err);
      alert("Error: " + err.message);
      window.location.reload();
    }
  };

  // [3] 오디오 처리 (수정됨: 강제 Resume 및 보간법 적용)
  const startAudioProcessing = async () => {
    // AudioContext 생성
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;

    // ★★★ 핵심 수정: 브라우저가 오디오를 막지 못하게 강제 실행 ★★★
    if (ctx.state === 'suspended') {
        await ctx.resume();
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    
    const targetRate = 16000; // Edge Impulse 목표 주파수
    const bufferSize = 16000; 
    let circularBuffer = new Float32Array(bufferSize);
    let writeIndex = 0;

    source.connect(processor);
    processor.connect(ctx.destination);

    processor.onaudioprocess = (e) => {
      if (!classifierRef.current) return;

      const inputData = e.inputBuffer.getChannelData(0);
      
      // ★★★ 핵심 수정: 단순하고 확실한 다운샘플링 (Linear Interpolation) ★★★
      // 복잡한 로직 다 버리고 가장 확실한 방법으로 16kHz로 변환합니다.
      const ratio = inputData.length / (ctx.sampleRate / targetRate * inputData.length / inputData.length); // 비율 계산
      const newLength = Math.floor(inputData.length * targetRate / ctx.sampleRate);
      const downsampled = new Float32Array(newLength);

      for (let i = 0; i < newLength; i++) {
          const originalIndex = i * (ctx.sampleRate / targetRate);
          const index1 = Math.floor(originalIndex);
          const index2 = Math.ceil(originalIndex);
          const weight = originalIndex - index1;
          
          const val1 = inputData[index1] || 0;
          const val2 = inputData[index2] || 0;
          downsampled[i] = val1 * (1 - weight) + val2 * weight;
      }
      // -----------------------------------------------------------

      // 원형 버퍼에 담기
      for (let i = 0; i < downsampled.length; i++) {
        circularBuffer[writeIndex] = downsampled[i];
        writeIndex = (writeIndex + 1) % bufferSize;
      }

      // 분류 실행
      let linearBuffer = new Float32Array(bufferSize);
      for (let i = 0; i < bufferSize; i++) {
        linearBuffer[i] = circularBuffer[(writeIndex + i) % bufferSize];
      }

      try {
        let results = classifierRef.current.classify(linearBuffer);
        let top = results.results.reduce((p, c) => p.value > c.value ? p : c);
        
        // 결과 업데이트 (0.5 이상이면 감지)
        if (top.label === 'korean' && top.value > 0.5) {
             lastKoreanTime.current = Date.now();
             setMicStatus("🔊 Korean Detected!");
             setMicClass("status-box active-red");
             checkViolation();
        } else {
             // 1.5초 동안 조용하면 다시 Listening으로
             if (Date.now() - lastKoreanTime.current > 1500) {
                 setMicStatus("🎤 Listening..."); // Standby 대신 Listening 표시
                 setMicClass("status-box");
             }
        }
      } catch (ex) {
          // 분류 에러 무시
      }
    };
  };

  // [4] 비디오 처리
  const startFaceMesh = async () => {
    const videoElement = document.getElementById('input_video');
    const canvasElement = document.getElementById('output_canvas');
    const ctx = canvasElement.getContext('2d');
    
    const faceMesh = new window.FaceMesh({locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`});
    faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5 });
    
    faceMesh.onResults((results) => {
      canvasElement.width = 500; canvasElement.height = 500;
      ctx.fillStyle = "black"; ctx.fillRect(0, 0, 500, 500);

      if (results.image && results.multiFaceLandmarks.length > 0) {
          const lm = results.multiFaceLandmarks[0];
          const sW = videoElement.videoWidth; const sH = videoElement.videoHeight;
          const upper = lm[13]; const lower = lm[14];
          const dist = Math.abs(upper.y - lower.y) * 100;
          
          const MAX_OPEN_DIST = 30; 
          let percent = (dist / MAX_OPEN_DIST) * 100;
          percent = Math.max(0, Math.min(percent, 100));

          const MOUTH_LIMIT = 5.0; 
          const isMouthOpenNow = (dist > MOUTH_LIMIT);

          const vStatus = document.getElementById('status-video');
          if (isMouthOpenNow) {
              lastMouthTime.current = Date.now();
              if(vStatus) {
                  vStatus.innerText = `👄 ${percent.toFixed(0)}% (Open)`;
                  vStatus.className = "status-box active-green"; 
              }
              checkViolation();
          } else {
              if(vStatus) {
                  vStatus.innerText = `🤐 ${percent.toFixed(0)}% (Closed)`;
                  vStatus.className = "status-box";
              }
          }

          const zoom = 4.0; const cw = sW/zoom; const ch = sH/zoom;
          let cx = ((upper.x + lower.x)/2 * sW) - cw/2;
          let cy = ((upper.y + lower.y)/2 * sH) - ch/2;
          ctx.drawImage(results.image, cx, cy, cw, ch, 0, 0, 500, 500);
      }
    });

    const camera = new window.Camera(videoElement, {
      onFrame: async () => { await faceMesh.send({image: videoElement}); },
      width: 1280, height: 720
    });
    await camera.start();
  };

  // [5] 위반 감지
  const checkViolation = () => {
    const now = Date.now();
    if (now - lastTriggerTime.current < 5000) return; 

    const isKoreanRecent = (now - lastKoreanTime.current < 3000);
    const isMouthRecent = (now - lastMouthTime.current < 3000);

    if (isKoreanRecent && isMouthRecent) {
      triggerDetection();
    }
  };

  const triggerDetection = () => {
    lastTriggerTime.current = Date.now(); 

    const overlay = document.getElementById('alert-overlay');
    if(overlay) {
        overlay.style.display = 'block';
        setTimeout(() => overlay.style.display = 'none', 2000);
    }
    
    // 이미지 변경 로직 (사용자님 원본 반영)
    const img = document.getElementById('monitor-image');
    if(img) {
        img.src = "2.jpg"; 
        img.classList.add('alert-mode');
        
        if (alertTimeout.current) clearTimeout(alertTimeout.current);
        alertTimeout.current = setTimeout(() => {
            img.src = "1.jpg"; 
            img.classList.remove('alert-mode');
        }, 5000);
    }

    const name = document.getElementById('input-name').value;
    const id = document.getElementById('input-id').value;
    if(dbRef.current) {
        dbRef.current.collection("detections").add({
            name: name, studentId: id, reason: "Korean + Mouth Open",
            timestamp: window.firebase.firestore.FieldValue.serverTimestamp()
        });
    }
  };

  // [6] 리스트 로드
  const loadList = () => {
      if(!dbRef.current) return;
      dbRef.current.collection("detections").orderBy("timestamp", "desc").onSnapshot(snapshot => {
        const list = document.getElementById('student-list'); 
        if(!list) return;
        list.innerHTML = "";
        
        const students = {};
        snapshot.forEach(doc => {
            const data = doc.data();
            const key = data.studentId;
            if (!students[key]) { students[key] = { name: data.name, id: data.studentId, records: [] }; }
            students[key].records.push({
                id: doc.id,
                time: data.timestamp ? new Date(data.timestamp.toDate()).toLocaleTimeString() : "Just now"
            });
        });

        Object.values(students).forEach(student => {
            const count = student.records.length;
            const isProblematic = count > 3; 
            
            const li = document.createElement('li'); 
            li.className = isProblematic ? 'student-item problematic' : 'student-item';
            
            li.innerHTML = `
                <div class="item-header">
                    <div class="student-info">
                        <b>${student.name} ${isProblematic ? '⚠️' : ''}</b><br>
                        <span>${student.id}</span>
                    </div>
                    <div class="count-badge" onclick="this.parentElement.nextElementSibling.style.display = this.parentElement.nextElementSibling.style.display === 'block' ? 'none' : 'block'">
                        ${count}
                    </div>
                </div>
                <div class="timestamp-list">
                    ${student.records.map(r => `<div>🕒 ${r.time}</div>`).join('')}
                </div>
            `;
            list.appendChild(li);
        });
    });
  };

  // [7] 기타 버튼
  const toggleList = () => {
      document.getElementById('list-panel').classList.toggle('open');
  };

  const authProfessor = () => {
    if (prompt("Enter Admin Password:") === "kyj") {
        alert("✅ Admin Mode Activated");
        document.getElementById('prof-controls').style.display = 'block';
        document.getElementById('btn-prof').style.display = 'none';
        loadList(); 
    } else {
        alert("❌ Wrong Password");
    }
  };

  const manualAdd = () => {
    const n = document.getElementById('add-name').value;
    const i = document.getElementById('add-id').value;
    if(n && i && dbRef.current) dbRef.current.collection("detections").add({name: n, studentId: i, timestamp: window.firebase.firestore.FieldValue.serverTimestamp()});
  };

  const deleteAllData = async () => {
    if (confirm("⚠️ WARNING: DELETE ALL?")) {
        const snapshot = await dbRef.current.collection("detections").get();
        const batch = dbRef.current.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        alert("Deleted.");
    }
  };

  // [8] HTML 렌더링 (사용자님 원본 HTML 100% 동일)
  return (
    <>
      <div id="sidebar">
        <div className="title-container">
            <h2>Korean Killer</h2>
            <div id="kk-logo">KK</div>
        </div>

        <input type="text" id="input-name" placeholder="Name" />
        <input type="text" id="input-id" placeholder="Student ID" />

        <button id="btn-start" onClick={startSystem}>▶ Start Monitoring</button>
        <div id="loading-msg" style={{display:'none'}}>Initializing...</div>

        <button id="btn-stop" onClick={() => window.location.reload()}>⏹ Stop System</button>
        <button id="btn-list" onClick={toggleList}>📋 Detection List</button>

        <div id="prof-controls">
            <p>👮‍♂️ [Professor Mode]</p>
            <input type="text" id="add-name" placeholder="Name" style={{marginBottom:'5px'}} />
            <input type="text" id="add-id" placeholder="ID" style={{marginBottom:'5px'}} />
            <button onClick={manualAdd} style={{background:'#ff9800'}}>Manual Add</button>
            <hr style={{borderColor:'#555', margin: '15px 0'}} />
            <button onClick={deleteAllData} className="btn-delete-all">⚠️ DELETE ALL DATA</button>
        </div>
        <button id="btn-prof" onClick={authProfessor}>🔒 Admin Auth</button>
      </div>

      <div id="list-panel">
        <h3>🚨 Detected Students</h3>
        <ul id="student-list" style={{listStyle: 'none', padding: 0}}></ul>
      </div>

      <div id="main-content">
        <img src="1.jpg" id="monitor-image" className="side-img" alt="Surveillance Monitor" />

        <div id="center-stage">
            <div id="placeholder" style={{textAlign:'center'}}>
                <h1 style={{color:'white'}}>System Standby</h1>
                <p style={{color:'#aaa'}}>Please enter your Name and ID to start.</p>
            </div>

            <div id="status-panel" style={{display:'none'}}>
                {/* 여기가 핵심: React State 변수로 제어하여 화면 갱신 보장 */}
                <div id="status-audio" className={micClass}>{micStatus}</div>
                <div id="status-video" className="status-box">🤐 0%</div>
            </div>

            <div id="camera-wrapper">
                <canvas id="output_canvas"></canvas>
                <div id="alert-overlay">🚨 DETECTED!</div>
            </div>
        </div>
      </div>

      <video id="input_video" playsInline style={{display:'none'}}></video>
    </>
  );
}

export default App;
