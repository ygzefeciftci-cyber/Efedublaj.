/* efedublaj — frontend (full-stack) */
(() => {
  // Socket.io bağlantısı — Render uyumlu
  const socket = io({
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
  });

  // ---------- state ----------
  let myUser = null;        // { id, name, email }
  let myRoomCode = null;    // current room code
  let mySocketId = socket.id;
  let dbScenes = [];
  let socketConnected = false;

  // ---------- DOM helpers ----------
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  function showView(id) {
    document.querySelectorAll('section.view').forEach(v => v.style.display = 'none');
    const el = $(`#view-${id}`);
    if (el) el.style.display = 'block';
    window.scrollTo(0, 0);
  }

  function toast(msg, ms = 3000) {
    const t = $('#toast');
    t.textContent = msg;
    t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, ms);
  }

  function esc(t) {
    return String(t).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ---------- API ----------
  async function api(path, opts = {}) {
    const headers = {};
    if (opts.body && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, { ...opts, headers });
    let data;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.data = data;
      throw err;
    }
    return data;
  }

  async function loadMe() {
    try {
      const { user } = await api('/api/me');
      myUser = user;
      updateAuthUI();
      updateSceneUploadUI();
      return user;
    } catch (e) {
      myUser = null;
      updateAuthUI();
      updateSceneUploadUI();
      return null;
    }
  }

  function updateAuthUI() {
    const btn = $('#btn-auth');
    if (!btn) return;
    if (myUser) {
      btn.textContent = myUser.name;
      btn.onclick = () => {
        if (confirm('Çıkış yapmak istediğinize emin misiniz?')) api('/api/logout', { method: 'POST' }).then(() => {
          myUser = null;
          myRoomCode = null;
          updateAuthUI();
          updateSceneUploadUI();
          showView('landing');
        });
      };
    } else {
      btn.textContent = 'Giriş / Kayıt';
      btn.onclick = () => showView('auth');
    }
  }

  function updateSceneUploadUI() {
    const section = $('#scene-video-upload');
    if (!section) return;
    if (myUser) {
      section.style.display = 'block';
      loadSceneSelect();
    } else {
      section.style.display = 'none';
    }
  }

  async function loadSceneSelect() {
    const sel = $('#scene-video-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">Sahne seçin</option>' + dbScenes.map(s => `<option value="${s.id}">${esc(s.title)}</option>`).join('');
  }

  // ---------- Auth view ----------
  let authTab = 'login';
  window.switchTab = (tab) => {
    authTab = tab;
    $('#auth-tabs').querySelectorAll('.tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    $('#auth-submit').textContent = tab === 'login' ? 'Giriş Yap' : 'Kayıt Ol';
  };
  $$('#auth-tabs .tab').forEach(b => b.addEventListener('click', () => window.switchTab(b.dataset.tab)));

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { email: fd.get('email'), name: fd.get('name'), password: fd.get('password') };
    try {
      if (authTab === 'login') {
        await api('/api/login', { method: 'POST', body });
      } else {
        await api('/api/signup', { method: 'POST', body });
      }
      await loadMe();
      showView('landing');
    } catch (err) {
      toast(err.message || 'Bir hata oluştu');
    }
  });

  // ---------- Landing ----------
  $('#btn-create').addEventListener('click', async () => {
    if (!myUser) { showView('auth'); return; }
    const name = $('#room-name').value.trim();
    try {
      const { room } = await api('/api/rooms', { method: 'POST', body: { name } });
      myRoomCode = room.code;
      socket.emit('join-room', { code: room.code, name: myUser.name });
      renderLobby(room);
      showView('lobby');
    } catch (err) { toast(err.message || 'Oda oluşturulamadı'); }
  });

  $('#btn-join').addEventListener('click', async () => {
    if (!myUser) { showView('auth'); return; }
    const code = $('#room-join').value.trim().toUpperCase();
    if (!code) { toast('Kod girin'); return; }
    try {
      const { room } = await api(`/api/rooms/${code}`);
      myRoomCode = code;
      socket.emit('join-room', { code, name: myUser.name });
      renderLobby(room);
      showView('lobby');
    } catch (err) { toast(err.message || 'Oda bulunamadı'); }
  });

  // ---------- Lobby rendering ----------
  function renderLobby(room) {
    $('#lobby-room-code').textContent = room.code;
    $('#lobby-users-count').textContent = `${room.users.length} kişi`;

    const me = room.users.find(u => u.id === myUser.id);
    const isOwner = room.owner === myUser.id;

    const playersHtml = room.users.map(u => `
      <div class="player-card ${u.id === myUser.id ? 'me' : ''}">
        <div class="player-name">${esc(u.name)}${u.id === myUser.id ? ' (sen)' : ''}</div>
        <div class="player-status">${u.ready ? 'Hazır ✓' : 'Bekliyor'}</div>
        ${u.char ? `<div class="char-pill">${esc(u.char)}</div>` : ''}
      </div>
    `).join('');

    // Sahne seçimi (sadece sahip)
    let scenePickerHtml = '';
    if (isOwner) {
      scenePickerHtml = `
        <div style="margin-bottom:1rem;">
          <label class="dj-label">Sahne seç (sadece sahip)</label>
          <div id="scene-picker" style="display:flex; gap:0.5rem; overflow-x:auto; padding-bottom:0.5rem;">
            ${dbScenes.map(s => {
              const selected = s.id === room.sceneId;
              const hasVideo = s.video ? ' ✓' : '';
              return `<button class="btn sm ${selected ? 'rec' : 'ghost'}" data-id="${s.id}">${esc(s.title)}${hasVideo}</button>`;
            }).join('')}
          </div>
        </div>
      `;
    }

    $('#lobby-content').innerHTML = `
      <div style="margin-bottom:1rem;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <span class="text-ink-faint" style="font-size:0.8rem;">Oda kodu</span>
          <span class="font-mono text-rec" style="letter-spacing:0.1em;">${room.code}</span>
        </div>
        <input type="text" value="${room.code}" readonly style="width:100%; background:var(--dj-bg); border:1px solid var(--dj-line); color:var(--dj-ink); padding:0.6rem 0.8rem; border-radius:6px; font-family:inherit; text-align:center; letter-spacing:0.15em;"/>
        <button id="btn-copy-code" class="btn sm" style="margin-top:0.5rem; width:100%;">Kodu Kopyala</button>
      </div>
      <div style="margin-bottom:1rem;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <span class="dj-label">Oyuncular (${room.users.length})</span>
          ${isOwner ? `<span style="font-size:0.75rem; color:var(--dj-rec); font-weight:700;">Sahip: ${esc(room.owner === myUser.id ? myUser.name : 'sen')}</span>` : ''}
        </div>
        <div class="player-grid">${playersHtml}</div>
      </div>
      ${scenePickerHtml}
      <div style="margin-bottom:1rem;">
        <label class="dj-label">Karakteriniz (1-6)</label>
        <div id="char-picker" style="display:flex; gap:0.5rem; overflow-x:auto; padding-bottom:0.5rem;">
          ${Array.from({length: 6}, (_, i) => i + 1).map(n => `
            <button class="btn sm ${me && me.char === String(n) ? 'rec' : 'ghost'}" data-char="${n}">Karakter ${n}</button>
          `).join('')}
        </div>
      </div>
      <div style="display:flex; gap:0.5rem; margin-bottom:1rem;">
        <button id="btn-ready" class="btn sm ${me.ready ? 'rec' : 'ghost'}" style="flex:1;">
          ${me.ready ? 'Hazırım ✓' : 'Hazırım'}
        </button>
        <button id="btn-start-game" class="btn sm rec" style="flex:1;" ${!(me && me.ready) ? 'disabled' : ''}>
          Oyunu Başlat
        </button>
      </div>
    `;

    // wire events
    $('#btn-copy-code').onclick = () => {
      const input = $('#lobby-content input[readonly]');
      input.select();
      document.execCommand('copy');
      $('#btn-copy-code').textContent = 'Kopyalandı!';
      setTimeout(() => $('#btn-copy-code').textContent = 'Kodu Kopyala', 1200);
    };

    $('#btn-leave-lobby').onclick = () => {
      socket.emit('leave-room', { code: room.code });
      myRoomCode = null;
      showView('landing');
    };

    $('#btn-ready').onclick = () => {
      api(`/api/rooms/${room.code}/ready`, { method: 'POST', body: { ready: !me.ready } });
    };

    $('#btn-start-game').onclick = () => {
      if (room.owner !== myUser.id) return;
      api(`/api/rooms/${room.code}/start`, { method: 'POST' }).then(() => {
        showView('player');
        renderPlayer(room);
      });
    };

    // Sahne seç (sadece sahip)
    if (isOwner) {
      $('#lobby-content').querySelectorAll('#scene-picker button').forEach(b => {
        b.onclick = () => {
          api(`/api/rooms/${room.code}/scene`, { method: 'POST', body: { sceneId: b.dataset.id } });
        };
      });
    }

    // Karakter seç
    $('#lobby-content').querySelectorAll('#char-picker button').forEach(b => {
      b.onclick = () => {
        api(`/api/rooms/${room.code}/char`, { method: 'POST', body: { char: b.dataset.char } });
      };
    });
  }

  // ---------- Scenes ----------
  async function loadScenes() {
    try {
      dbScenes = await api('/api/scenes');
      loadSceneSelect();
    } catch (e) {
      dbScenes = [];
    }
  }
  function renderScenes() {
    const grid = $('#scenes-grid');
    grid.innerHTML = dbScenes.map(s => {
      const hasVideo = s.video ? '✓ video yüklü' : '✗ video yok';
      const videoColor = s.video ? 'text-green' : 'text-ink-faint';
      return `
        <a href="#" class="scene-card" data-id="${s.id}">
          <div class="scene-thumb">
            <span class="scene-play">▶</span>
            <div style="position:absolute; inset:0; display:flex; align-items:flex-end; justify-content:flex-end; padding:0.5rem;">
              <span style="background:rgba(0,0,0,.6); color:#fff; padding:0.15rem 0.5rem; border-radius:4px; font-size:0.7rem;">${Math.floor(s.duration/60)}:${String(s.duration%60).padStart(2,'0')}</span>
            </div>
          </div>
          <div class="scene-body">
            <div class="scene-title">${esc(s.title)}</div>
            <div class="scene-meta ${videoColor}">${s.chars} karakter · ${esc(hasVideo)}</div>
          </div>
        </a>
      `;
    }).join('');
    grid.querySelectorAll('.scene-card').forEach(card => {
      card.addEventListener('click', (e) => {
        e.preventDefault();
        const id = card.dataset.id;
        if (!myRoomCode) { toast('Önce bir odaya katılın'); return; }
        api(`/api/rooms/${myRoomCode}/scene`, { method: 'POST', body: { sceneId: id } });
      });
    });
  }

  // Sahne video yükle
  $('#btn-upload-scene-video').addEventListener('click', async () => {
    const sel = $('#scene-video-select');
    const fileInput = $('#scene-video-file');
    const sceneId = sel.value;
    const file = fileInput.files[0];
    const msgEl = $('#scene-video-msg');

    if (!sceneId) { toast('Sahne seçin'); return; }
    if (!file) { toast('Video dosyası seçin'); return; }

    const form = new FormData();
    form.append('video', file);
    try {
      msgEl.textContent = 'Yükleniyor...';
      const res = await api(`/api/scenes/${sceneId}/video`, { method: 'POST', body: form });
      msgEl.textContent = 'Video yüklendi!';
      fileInput.value = '';
      loadScenes();
      renderScenes();
      setTimeout(() => { msgEl.textContent = ''; }, 2000);
    } catch (err) {
      msgEl.textContent = 'Hata: ' + (err.message || '');
      toast('Video yükleme hatası: ' + (err.message || ''));
    }
  });

  // ---------- Player view ----------
  let mediaRecorder = null;
  let isRecording = false;
  let recordedChunks = [];

  function renderPlayer(room) {
    $('#player-room-code').textContent = room.code;
    $('#player-users-count').textContent = `${room.users.length} kişi`;

    const playersHtml = room.users.map(u => `
      <div class="player-card ${u.id === myUser.id ? 'me' : ''}">
        <div class="player-name">${esc(u.name)}${u.id === myUser.id ? ' (sen)' : ''}</div>
        <div class="player-status">${u.ready ? 'Hazır ✓' : 'Bekliyor'}</div>
        ${u.char ? `<div class="char-pill">${esc(u.char)}</div>` : ''}
      </div>
    `).join('');
    $('#player-grid').innerHTML = playersHtml;

    const s = dbScenes.find(x => x.id === room.sceneId);
    $('#player-scene-info').textContent = s ? `Sahne: ${s.title} · ${s.chars} karakter` : 'Sahne seçilmedi';

    if (s) {
      let stageHtml = '';
      if (s.video && s.video.url) {
        stageHtml = `
          <video id="scene-video" controls autoplay src="${s.video.url}" style="width:100%; height:100%; object-fit:cover; background:#000;"></video>
          <div style="position:absolute; bottom:1rem; right:1rem; z-index:10; background:rgba(0,0,0,.6); color:#fff; padding:0.4rem 0.8rem; border-radius:6px; font-size:0.8rem; font-family:var(--dj-font-mono);">
            ${esc(s.video.originalname || 'video')}
          </div>
        `;
      } else {
        stageHtml = `
          <div style="width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--dj-ink-soft); font-family:var(--dj-font-mono); gap:0.5rem;">
            <div style="font-size:1.1rem; font-weight:700; color:var(--dj-ink);">${esc(s.title)}</div>
            <div>${Math.floor(s.duration/60)}:${String(s.duration%60).padStart(2,'0')} · ${s.chars} karakter</div>
            <div style="font-size:0.75rem; color:var(--dj-ink-faint);">Oda sahibi bu sahneye video yüklemedi.</div>
          </div>
        `;
      }
      $('#video-stage').innerHTML = stageHtml;
    }

    // recording
    $('#btn-record').onclick = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        mediaRecorder = new MediaRecorder(stream);
        recordedChunks = [];
        mediaRecorder.ondataavailable = e => { if (e.data.size) recordedChunks.push(e.data); };
        mediaRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          const blob = new Blob(recordedChunks, { type: 'video/webm' });
          const form = new FormData();
          form.append('video', blob, 'kayit.webm');
          form.append('roomCode', room.code);
          form.append('sceneId', room.sceneId || '');
          try {
            const { recording } = await api('/api/upload', { method: 'POST', body: form });
            toast('Kayıt yüklendi');
            loadMyRecordings();
          } catch (err) { toast('Yükleme hatası: ' + (err.message || '')); }
          $('#video-stage').innerHTML = `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:var(--dj-ink-soft); font-family:var(--dj-font-mono);">Kayıt tamamlandı ve sunucuya yüklendi.</div>`;
        };
        mediaRecorder.start();
        isRecording = true;
        $('#btn-record').style.display = 'none';
        $('#btn-stop-record').style.display = 'inline-flex';
        socket.emit('start-recording', { code: room.code });
        $('#video-stage').innerHTML = `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:var(--dj-rec); font-weight:800; font-family:var(--dj-font-mono);">CANLI KAYIT …</div>`;
      } catch (err) {
        toast('Kamera/mikrofon izni gerekli: ' + err.message);
      }
    };

    $('#btn-stop-record').onclick = () => {
      if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;
        $('#btn-record').style.display = 'inline-flex';
        $('#btn-stop-record').style.display = 'none';
        socket.emit('stop-recording', { code: room.code });
      }
    };

    $('#btn-leave-player').onclick = () => {
      if (confirm('Odanızdan çıkılsın mı?')) {
        socket.emit('leave-room', { code: room.code });
        myRoomCode = null;
        showView('landing');
      }
    };

    // chat
    $('#btn-send-chat').onclick = () => {
      const input = $('#player-chat-input');
      const t = input.value.trim();
      if (!t) return;
      socket.emit('chat-msg', { code: room.code, from: myUser.name, text: t });
      input.value = '';
    };
    $('#player-chat-input').addEventListener('keypress', e => { if (e.key === 'Enter') $('#btn-send-chat').click(); });
  }

  // ---------- Socket events ----------
  socket.on('connect', () => {
    mySocketId = socket.id;
    socketConnected = true;
    // Eğer zaten bir odadayızsa yeniden katıl
    if (myRoomCode && myUser) {
      socket.emit('join-room', { code: myRoomCode, name: myUser.name });
    }
  });
  socket.on('disconnect', () => {
    socketConnected = false;
    toast('Bağlantı koptu, yeniden bağlanılıyor…');
  });
  socket.on('connect_error', (err) => {
    socketConnected = false;
    toast('Sunucuya bağlanılamıyor: ' + (err.message || ''));
  });
  socket.on('room-state', (room) => {
    myRoomCode = room.code;
    renderLobby(room);
  });
  socket.on('user-joined', () => {});
  socket.on('user-left', () => {});
  socket.on('chat-msg', ({ from, text, at }) => {
    const box = $('#player-chat-box');
    const div = document.createElement('div');
    div.style.cssText = 'display:flex; flex-direction:column; gap:0.15rem;';
    div.innerHTML = `<div style="font-size:0.75rem; font-weight:700; color:var(--dj-ink-faint);">${esc(from)}</div><div style="color:var(--dj-ink);">${esc(text)}</div>`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  });
  socket.on('peer-started', () => {
    $('#video-stage').innerHTML = `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:var(--dj-rec); font-weight:800; font-family:var(--dj-font-mono);">Bir oyuncu kayıt etmeye başladı …</div>`;
  });
  socket.on('peer-stopped', () => {
    $('#video-stage').innerHTML = `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:var(--dj-ink-soft); font-family:var(--dj-font-mono);">Kayıt durdu.</div>`;
  });
  socket.on('start-game', ({ sceneId }) => {
    const s = dbScenes.find(x => x.id === sceneId);
    $('#player-room-code').textContent = myRoomCode || '';
    $('#player-users-count').textContent = '–';
    $('#player-scene-info').textContent = s ? `Sahne: ${s.title}` : 'Sahne seçilmedi';
    if (s) {
      let stageHtml = '';
      if (s.video && s.video.url) {
        stageHtml = `
          <video id="scene-video" controls autoplay src="${s.video.url}" style="width:100%; height:100%; object-fit:cover; background:#000;"></video>
          <div style="position:absolute; bottom:1rem; right:1rem; z-index:10; background:rgba(0,0,0,.6); color:#fff; padding:0.4rem 0.8rem; border-radius:6px; font-size:0.8rem; font-family:var(--dj-font-mono);">
            ${esc(s.video.originalname || 'video')}
          </div>
        `;
      } else {
        stageHtml = `
          <div style="width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--dj-ink-soft); font-family:var(--dj-font-mono); gap:0.5rem;">
            <div style="font-size:1.1rem; font-weight:700; color:var(--dj-ink);">${esc(s.title)}</div>
            <div>${Math.floor(s.duration/60)}:${String(s.duration%60).padStart(2,'0')} · ${s.chars} karakter</div>
            <div style="font-size:0.75rem; color:var(--dj-ink-faint);">Oda sahibi bu sahneye video yüklemedi.</div>
          </div>
        `;
      }
      $('#video-stage').innerHTML = stageHtml;
    }
    showView('player');
  });

  // ---------- Recordings / Dubs ----------
  async function loadMyRecordings() {
    try {
      const recs = await api('/api/recordings');
      renderRecordings(recs);
    } catch (e) {
      $('#dubs-list').innerHTML = `<p style="color:var(--dj-ink-faint);">Kayıtlar yüklenemedi.</p>`;
    }
  }
  function renderRecordings(recs) {
    const list = $('#dubs-list');
    if (recs.length === 0) {
      list.innerHTML = `<p style="color:var(--dj-ink-faint);">Henüz kayıt yok. Oda içinden bir ses kaydı yapın.</p>`;
      return;
    }
    list.innerHTML = recs.map(r => `
      <div class="dub-card">
        <div style="font-weight:700; color:var(--dj-ink);">${esc(r.originalname)}</div>
        <div class="dub-meta">${new Date(r.createdAt).toLocaleString('tr-TR')} · ${(r.size/1024/1024).toFixed(1)} MB · ${r.status}</div>
        ${r.mergedUrl ? `<a href="${r.mergedUrl}" target="_blank" class="btn sm">Birleştirilmiş Videoyu İzle</a>` : ''}
        <div class="dub-actions">
          <button class="btn sm ghost" onclick="mergeRecordings([${JSON.stringify(r.id)}])">Birleştir</button>
        </div>
      </div>
    `).join('');
  }
  window.mergeRecordings = async (ids) => {
    try {
      const { mergedUrl } = await api('/api/merge', { method: 'POST', body: { recordingIds: ids, outputName: 'efedublaj-merged' } });
      toast('Video birleştirildi');
      loadMyRecordings();
    } catch (err) { toast('Birleştirme hatası: ' + (err.message || '')); }
  };

  // ---------- Nav ----------
  $$('.nav-link').forEach(a => {
    a.addEventListener('click', (e) => {
      const href = a.getAttribute('href');
      if (href === '#landing') { e.preventDefault(); showView('landing'); }
      if (href === '#scenes') { e.preventDefault(); loadScenes(); renderScenes(); showView('scenes'); }
      if (href === '#dubs') { e.preventDefault(); if (!myUser) { showView('auth'); return; } loadMyRecordings(); showView('dubs'); }
    });
  });

  // ---------- boot ----------
  async function boot() {
    await loadMe();
    await loadScenes(); // sahne listesini en başta yükle
    if (myUser) {
      // already logged in
    } else {
      showView('landing');
    }
  }
  boot();
})();
