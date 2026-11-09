const $ = (id) => document.getElementById(id);
const map = L.map('map', { zoomControl: true }).setView([-6.2, 106.816666], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
let marker = null, selectedFile = null, lastLocation = null;
const addressInput = $('addressInput');

function setStatus(message, isError=false) {
  $('status').textContent = message;
  $('status').style.color = isError ? '#d34b58' : '#4169e1';
}
function setBusy(busy, label='Sedang mencari...') {
  $('findBtn').disabled = busy;
  $('findBtn').querySelector('span:first-child').textContent = busy ? label : 'Temukan lokasi';
}
function showLocation(lat, lon, title, address, zoom=18) {
  lastLocation = {lat, lon, title, address};
  if (marker) map.removeLayer(marker);
  marker = L.marker([lat, lon]).addTo(map).bindPopup(`<b>${escapeHtml(title)}</b><br>${escapeHtml(address)}`).openPopup();
  map.setView([lat, lon], zoom);
  $('mapState').textContent = 'Titik ditemukan';
  $('mapState').style.color = '#168b68';
  $('mapState').style.background = '#e7f8f1';
  $('resultCard').innerHTML = `<div class="result-icon">⌖</div><div class="result-copy"><b>${escapeHtml(title)}</b><small>${escapeHtml(address)}<br>${lat.toFixed(6)}, ${lon.toFixed(6)}</small></div>`;
  $('directionsBtn').disabled = false;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&countrycodes=id&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {headers: {'Accept-Language':'id'}});
  if (!response.ok) throw new Error('Layanan pencarian alamat sedang tidak tersedia. Coba lagi.');
  return response.json();
}
function makeOcrCanvas(file, rotation, enhance=true) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      const sideways = rotation === 90 || rotation === 270;
      const scale = Math.min(1.7, 2400 / Math.max(image.width, image.height));
      const w = Math.round(image.width * scale), h = Math.round(image.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = sideways ? h : w;
      canvas.height = sideways ? w : h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(rotation * Math.PI / 180);
      ctx.drawImage(image, -w / 2, -h / 2, w, h);
      if (enhance) {
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = frame.data;
        // Grayscale + contrast boost helps faded thermal shipping labels.
        for (let i = 0; i < d.length; i += 4) {
          const gray = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
          const value = Math.max(0, Math.min(255, (gray - 118) * 1.42 + 128));
          d[i] = d[i+1] = d[i+2] = value;
        }
        ctx.putImageData(frame, 0, 0);
      }
      URL.revokeObjectURL(objectUrl);
      resolve(canvas);
    };
    image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Foto tidak bisa dibuka. Coba pilih foto lain.')); };
    image.src = objectUrl;
  });
}

function addressCandidateFromOcr(raw) {
  const lines = raw.split(/\r?\n/)
    .map(s => s.replace(/[|]/g, 'I').replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 2);

  // Fokus ke bagian penerima bila penanda tersebut berhasil dikenali.
  const receiverIndex = lines.findIndex(s => /penerima/i.test(s));
  let area = receiverIndex >= 0 ? lines.slice(receiverIndex, receiverIndex + 10) : lines;
  area = area.filter(s => !/j&t|express|barcode|order id|estimated date|berat|jumlah|pengirim|telepon|shipper/i.test(s));
  const useful = area.filter(s =>
    /\b(jl|jalan|gg|gang|no|nomor|rt|rw|kel|kelurahan|kec|kecamatan|desa|dusun|blok|perumahan|komplek|ciracas|jakarta|depok|bekasi|tangerang|bogor|kodepos|pos)\b/i.test(s)
  );
  const chosen = useful.length ? useful : area;
  const text = chosen.join(', ').replace(/,\s*,/g, ', ').replace(/\s+/g, ' ').trim();
  const score =
    (useful.length * 5) +
    (/\b(jl|jalan|gang)\b/i.test(text) ? 10 : 0) +
    (/\b(rt|rw)\b/i.test(text) ? 5 : 0) +
    (/\b(jakarta|ciracas|depok|bekasi|tangerang|bogor)\b/i.test(text) ? 8 : 0) +
    (/\b\d{5}\b/.test(text) ? 4 : 0);
  return { text, lines, score };
}

async function readAddressFromPhoto(file) {
  if (!window.Tesseract) throw new Error('Mesin pembaca foto belum termuat. Pastikan internet aktif, lalu muat ulang halaman.');
  const rotations = [90, 270, 0, 180];
  let best = null;
  for (let i = 0; i < rotations.length; i++) {
    setStatus(`Mengenali arah dan tulisan label (${i + 1}/4)...`);
    const canvas = await makeOcrCanvas(file, rotations[i], true);
    let result;
    result = await Tesseract.recognize(canvas, 'eng', {
      logger: m => {
        if (m.status === 'recognizing text') setStatus(`Membaca alamat dari foto: ${Math.round(m.progress * 100)}%`);
      },
      // Sparse-text mode works better for courier labels containing separate address blocks.
      config: { tessedit_pageseg_mode: '12', preserve_interword_spaces: '1' }
    });
    const candidate = addressCandidateFromOcr(result.data.text || '');
    if (!best || candidate.score > best.score) best = candidate;
    if (candidate.score >= 20 && /\b(jl|jalan|gang)\b/i.test(candidate.text)) break;
  }
  if (!best || best.text.length < 8) throw new Error('Alamat belum terbaca. Coba foto lebih dekat dan pastikan seluruh label masuk ke dalam gambar.');
  return best.text;
}
async function findAddressOnMap(query) {
  setStatus('Mencocokkan alamat dengan peta...');
  let results = await geocode(query);
  let usedQuery = query;
  let approximate = false;

  // Many maps do not index house numbers or small alleys. Retry using the street and area.
  if (!results.length) {
    const parts = query.split(',').map(s => s.trim()).filter(Boolean);
    const street = parts.filter(s => /\b(jl|jalan|gang|gg|rt|rw|ciracas|jakarta|depok|bekasi|tangerang|bogor)\b/i.test(s));
    const fallback = street.length ? street.join(', ') + ', Indonesia' : query + ', Indonesia';
    if (fallback.toLowerCase() !== query.toLowerCase()) {
      setStatus('Alamat lengkap belum terdaftar. Mencoba mencari nama jalan dan wilayah...');
      results = await geocode(fallback);
      usedQuery = fallback;
      approximate = true;
    }
  }
  if (!results.length) {
    throw new Error('Alamat terbaca, tetapi belum ditemukan di peta. Teks alamat tetap ada di kolom; periksa ejaan atau tambahkan nama kelurahan/kecamatan.');
  }
  const best = results[0];
  showLocation(Number(best.lat), Number(best.lon), best.name || 'Lokasi tujuan', best.display_name, Number(best.place_rank) > 25 ? 18 : 16);
  if (approximate) {
    setStatus('Peta menemukan area jalan/wilayah, tetapi belum memastikan nomor rumah. Cocokkan titik dengan penerima sebelum berangkat.');
  } else if (results.length > 1) {
    setStatus(`Lokasi ditemukan. Ada ${results.length} kemungkinan hasil; cocokkan nama jalan dan wilayah pada peta sebelum berangkat.`);
  } else {
    setStatus('Lokasi ditemukan. Periksa kembali titik rumah sebelum berangkat.');
  }
}
$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  let query = addressInput.value.trim();
  const photoMode = $('photoTab').classList.contains('active');
  if (!query && photoMode && selectedFile) {
    setBusy(true, 'Membaca foto...');
    try {
      query = await readAddressFromPhoto(selectedFile);
      addressInput.value = query;
      setStatus('Alamat berhasil dibaca. Sedang mencari titik rumah di peta...');
      await findAddressOnMap(query);
    } catch (err) {
      setStatus(err.message || 'Gagal membaca atau mencari alamat dari foto.', true);
    } finally { setBusy(false); }
    return;
  }
  if (!query && photoMode && !selectedFile) { setStatus('Unggah foto label paket terlebih dahulu.', true); return; }
  if (!query) { setStatus('Masukkan alamat atau unggah foto label paket terlebih dahulu.', true); return; }
  setBusy(true);
  try { await findAddressOnMap(query); }
  catch (err) { setStatus(err.message || 'Terjadi kesalahan saat mencari alamat.', true); }
  finally { setBusy(false); }
});
$('textTab').addEventListener('click', () => {
  $('textTab').classList.add('active'); $('photoTab').classList.remove('active');
  $('textTab').setAttribute('aria-selected','true'); $('photoTab').setAttribute('aria-selected','false');
  $('photoArea').hidden = true; addressInput.placeholder = 'Contoh: Jl. Margonda Raya No. 10, Depok';
});
$('photoTab').addEventListener('click', () => {
  $('photoTab').classList.add('active'); $('textTab').classList.remove('active');
  $('photoTab').setAttribute('aria-selected','true'); $('textTab').setAttribute('aria-selected','false');
  $('photoArea').hidden = false; addressInput.placeholder = 'Alamat hasil pembacaan foto akan muncul di sini';
});
$('photoInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { setStatus('File harus berupa gambar.', true); return; }
  if (file.size > 10 * 1024 * 1024) { setStatus('Ukuran foto maksimal 10 MB.', true); return; }
  selectedFile = file;
  $('previewImage').src = URL.createObjectURL(file);
  $('fileName').textContent = file.name;
  $('ocrStatus').textContent = 'Foto siap dibaca';
  $('previewWrap').hidden = false;
  $('status').textContent = '';
});
$('removePhoto').addEventListener('click', () => {
  selectedFile = null; $('photoInput').value = ''; $('previewWrap').hidden = true;
});
$('clearBtn').addEventListener('click', () => { addressInput.value = ''; addressInput.focus(); setStatus(''); });
$('myLocationBtn').addEventListener('click', () => {
  if (!navigator.geolocation) { setStatus('Browser tidak mendukung GPS.', true); return; }
  setStatus('Meminta izin lokasi perangkat...');
  navigator.geolocation.getCurrentPosition(pos => {
    const {latitude, longitude, accuracy} = pos.coords;
    showLocation(latitude, longitude, 'Lokasi perangkat Anda', `Akurasi GPS sekitar ${Math.round(accuracy)} meter`, 17);
    setStatus(`Lokasi perangkat berhasil didapat. Akurasi GPS ±${Math.round(accuracy)} meter.`);
  }, err => setStatus('Lokasi tidak bisa diakses. Aktifkan GPS dan izinkan akses lokasi pada browser.', true), {enableHighAccuracy:true, timeout:15000, maximumAge:0});
});
$('directionsBtn').addEventListener('click', () => {
  if (!lastLocation) return;
  const {lat, lon} = lastLocation;
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`, '_blank', 'noopener');
});
