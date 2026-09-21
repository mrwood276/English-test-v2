# Audit English Daily Test v1

> Audit aplikasi yang sedang berjalan (v1), sebagai dasar sebelum Fase 0 dan Fase 1 v2. **Tidak ada yang diubah** di frontend maupun di proyek Supabase; semua pemeriksaan bersifat membaca.
>
> **Cakupan:** seluruh file frontend yang kamu upload (`index.html`, `exam.js`, `admin.js`, `results.js`, `api.js`, `app.js`, `state.js`, `timer.js`, `config.js`, `tailwind-config.js`, `style.css`, `components.css`), skema database, hasil pemeriksaan keamanan bawaan Supabase, dan kode 4 dari 7 Edge Function (`submit-exam`, `start-exam`, `teacher-login`, `teacher-questions`, termasuk kode bersama `_shared.ts`). Tiga function lain (`get-exam-info`, `teacher-settings`, `teacher-results`) tidak saya baca baris demi baris; polanya sama dengan yang lain.
>
> **Yang tidak saya buka:** isi baris tabel (termasuk password guru dan data siswa). Rahasia penandatangan token terlihat di kode function; nilainya sengaja tidak saya tulis di sini.

---

## 1. Temuan yang memengaruhi keputusan desain

| No | Temuan | Dampak |
|---|---|---|
| **K-1** | **Kelas di v1 bukan ketik bebas.** Login siswa memakai dropdown dengan 3 kelas yang ditulis langsung di HTML (XII TKJ A/B/C), begitu juga filter kelas di dashboard guru. Server tidak memeriksa nilai kelas sama sekali. | Keputusan D-01 ("ketik bebas seperti sekarang") didasarkan pada penjelasan saya yang keliru: waktu itu saya belum membaca `index.html`. D-01 perlu dijawab ulang dengan fakta yang benar. |
| **K-2** | Tingkat kesulitan di v1 adalah **Easy / Medium / HOTS**, bukan easy/medium/hard seperti di Dokumen Desain. | Dokumen Desain perlu disesuaikan dengan istilah yang sudah kamu pakai. |
| **K-3** | **Belum ada batas percobaan dan belum ada buka/tutup ujian.** Setiap panggilan `start-exam` membuat sesi baru, jadi siswa yang tahu alamat aplikasinya bisa mengerjakan berulang kali kapan saja. | Aturan "1 kali", kode ujian, dan jadwal di v2 adalah fitur baru, bukan penyempurnaan. Selama v1 dipakai, ujian tidak terkunci. |
| **K-4** | **Server tidak menegakkan waktu ujian.** `submit-exam` menerima jawaban kapan pun, tanpa memeriksa `ends_at`. Batas waktu hanya dijaga timer di browser. | Siswa yang mengubah data di browser bisa mengerjakan melewati durasi. v2 harus menolak atau menandai pengumpulan yang terlambat. |

---

## 2. Inventaris fitur yang sudah ada

**Siswa:** masuk dengan nama + kelas · info ujian (jumlah soal, durasi, passing grade) · petunjuk · timer berbasis waktu server · palet nomor soal · tandai "review" · progress bar dan lencana · pilihan diacak dan soal diacak (diatur guru) · lanjut setelah refresh · konfirmasi sebelum kumpul (peringatan soal kosong) · kumpul otomatis saat waktu habis · halaman hasil dengan konfeti · review jawaban (bila diizinkan guru).

**Guru:** login dengan satu password · statistik (total, rata-rata, tertinggi, terendah, lulus, tidak lulus) · tabel hasil dengan cari, filter kelas, urut · detail jawaban per siswa · jumlah pindah tab · hapus satu hasil atau semua · ekspor CSV · tambah/ubah/hapus soal · pengaturan ujian (judul, durasi, passing grade, jumlah soal, acak soal, acak pilihan, izinkan review kunci jawaban).

**Backend:** 5 tabel dengan RLS aktif tanpa policy · 7 Edge Function · penilaian di server dengan kunci per sesi.

---

## 3. Yang baik dan sebaiknya dipertahankan

- **Kunci jawaban tidak pernah dikirim ke browser siswa sebelum submit**; penilaian di server memakai `correct_map` per sesi, dan tiap sesi menyimpan salinan soalnya. Ini menjadi dasar BR-09 dan BR-10.
- **RLS aktif di semua tabel tanpa policy** dengan akses hanya lewat Edge Function. Pemeriksaan keamanan Supabase hanya mengeluarkan 5 catatan berlevel INFO yang semuanya menyebut hal ini, sesuai rancangan, bukan masalah.
- **Timer memakai jam dinding dari `endsAt`**, jadi tetap akurat walau tab dibatasi browser atau perangkat tidur sebentar.
- **Nama siswa di-escape** sebelum ditampilkan di dashboard guru (`escapeHtml`), mencegah stored XSS lewat kolom nama.
- **Pemisahan berkas rapi:** satu klien API (`api.js`), satu file per area. Pembagian ini mudah dipetakan ke modul v2.
- **Resume sesi, penandaan review, palet, dan progress** sudah nyaman dipakai dan tetap dipertahankan.

---

## 4. Masalah yang ditemukan

### Tinggi

| No | Masalah | Di mana | Saran |
|---|---|---|---|
| H-1 | Waktu ujian tidak ditegakkan server (K-4) | `submit-exam` | v2: tolak/tandai pengumpulan setelah `ends_at` + toleransi kecil |
| H-2 | Tanpa batas percobaan, tanpa buka/tutup ujian, tanpa kode (K-3) | `start-exam` | v2: aturan 1 kali, kode ujian wajib, status ujian |
| H-3 | Password guru disimpan sebagai teks biasa dan dibandingkan langsung; tidak ada pembatasan percobaan login sehingga bisa ditebak berulang | tabel `app_config`, `teacher-login` | v2: Supabase Auth. Sebelum itu: ganti password default |
| H-4 | Rahasia penandatangan token tertulis langsung di kode dan diulang di semua function. Siapa pun yang bisa membaca kode function bisa membuat token guru palsu. | `_shared.ts` di tiap function | v2 menghapus mekanisme ini. Jika v1 masih lama dipakai, pindahkan ke Edge Function Secrets dan ganti nilainya |
| H-5 | Nama dan kelas tidak divalidasi di server (panjang, isi, kelas yang valid), dan `start-exam` bisa dipanggil siapa saja tanpa pembatasan laju. Tiap panggilan menyimpan salinan 40 soal, jadi database bisa dibanjiri sesi sampah. | `start-exam` | v2: validasi, pembatasan laju, pembersihan sesi kedaluwarsa |

### Sedang

| No | Masalah | Di mana | Saran |
|---|---|---|---|
| M-1 | Jawaban hanya disimpan di localStorage sampai submit. HP mati atau data browser terhapus berarti jawaban hilang. Kalau pengumpulan otomatis gagal saat koneksi putus, siswa hanya melihat alert dan tidak ada percobaan ulang. | `exam.js`, `timer.js` | v2: simpan ke server per jawaban, antrean kirim ulang saat koneksi kembali |
| M-2 | Hasil ganda bisa tercipta: pemeriksaan "sudah dikumpulkan" tidak atomik, tabel `exam_results` tidak punya batasan unik pada `session_id`, dan penyimpanan hasil serta pembaruan sesi berjalan sebagai dua perintah terpisah | `submit-exam`, skema | v2: batasan unik dan satu transaksi |
| M-3 | Jumlah pindah tab dihitung di browser dan dikirim saat submit, jadi bisa diubah atau dilewatkan siswa | `app.js`, `submit-exam` | v2: kejadian dicatat ke server saat terjadi |
| M-4 | Teks soal dan teks bacaan ditampilkan sebagai HTML mentah (`innerHTML`). Aman selama guru satu-satunya penulis, tapi tidak aman setelah impor dari Word/Excel. | `exam.js` | v2: bersihkan HTML (sanitasi) saat disimpan dan ditampilkan |
| M-5 | Pesan error server diteruskan mentah ke browser (`String(e)`), bisa mengungkap detail internal | semua function | Pesan umum ke pengguna, detail hanya di log |
| M-6 | Ekspor CSV memakai data URI: karakter `#` di nama memotong file, dan nama yang diawali `=`, `+`, `-`, atau `@` bisa dijalankan sebagai rumus di Excel | `results.js` | v2: unduh sebagai file (Blob) dan netralkan awalan rumus |
| M-7 | Ketergantungan CDN: Tailwind versi CDN (dikompilasi di browser, tidak dianjurkan untuk produksi), Font Awesome, confetti, dan Google Fonts lewat `@import`. Kalau jaringan sekolah lambat atau memblokir, tampilan rusak atau lama. | `index.html`, `style.css` | v2: CSS hasil kompilasi dan aset disimpan sendiri (keputusan teknis, dibahas di Fase 1) |
| M-8 | Status "LULUS" / "BELUM LULUS" tersimpan di database dan tampil di UI berbahasa Inggris | `submit-exam`, `exam.js` | v2: kode status netral (`passed`/`failed`), label tampilan Inggris |
| M-9 | Tombol "Back to Home" saat ujian membuka layar login sementara timer dan sesi tetap berjalan; kembali ke ujian hanya lewat refresh | `exam.js` | Ganti dengan aksi yang jelas atau nonaktifkan saat ujian |
| M-10 | 7 dari 8 sesi di database belum pernah dikumpulkan (sebagian mungkin uji coba) dan tidak ada status kedaluwarsa | skema | v2: status sesi (`timed_out`) dan pembersihan terjadwal |

### Rendah

| No | Masalah | Saran |
|---|---|---|
| L-1 | Kolom `correct`, `wrong`, `time_used` di `exam_results` menduplikasi `correct_count`, `wrong_count`, `time_used_seconds` dan tidak terpakai | Dihapus saat migrasi |
| L-2 | Teks usang di tab Exam Settings masih menyebut "client-side prototype" dan LocalStorage | Diperbarui |
| L-3 | Judul dan teks tertulis langsung ("NARRATIVE TEXT & GRAMMAR • SMK GRADE 12", "Passed (≥75)") | Diambil dari pengaturan |
| L-4 | Variabel global dan `onclick` di HTML membuat kode sulit dirawat dan diuji | Modul ES per fitur |
| L-5 | `alert()` dan `confirm()` memblokir layar dan kurang nyaman di HP | Dialog di dalam halaman |
| L-6 | Satu kunci localStorage per browser: perangkat yang dipakai bergantian bisa menawarkan "lanjutkan" sesi orang lain | Kunci per sesi dan pembersihan |
| L-7 | `fetch` tanpa batas waktu (timeout) | Tambah timeout dan pesan yang jelas |
| L-8 | Validasi soal di `teacher-questions` minim (tipe pilihan, panjang teks); `correctIndex` hanya dilindungi batasan di database | Validasi lengkap di server |

---

## 5. Peta v1 ke v2

| Bagian v1 | Nasib | Keterangan |
|---|---|---|
| Keamanan penilaian (kunci per sesi, salinan soal, RLS tanpa policy) | **Dipertahankan** | Dasar BR-09 dan BR-10 |
| Timer berbasis `endsAt` | **Dipertahankan + diperkuat** | Ditambah penegakan di server |
| Palet, flag review, progress, resume | **Dipertahankan** | Tampilan baru mengikuti mockup Fase 0 |
| `api.js` (satu klien API) | **Direfactor** | Dipecah per domain; ditambah timeout dan antrean kirim ulang |
| `state.js`, `exam.js`, `results.js`, `admin.js` | **Direfactor** | Dari global + `onclick` menjadi modul ES |
| `exam_settings` (1 baris) | **Diganti** | Tabel `exams` |
| `questions` (`correct_index`, `options` JSON) | **Diganti dan dimigrasi** | `questions` + `question_options`; 40 soal ikut dipindah |
| `exam_sessions`, `exam_results` | **Diganti** | Struktur baru; data lama diarsipkan atau dipindah (D-13) |
| `app_config.teacher_password`, token HMAC | **Dihapus** | Digantikan Supabase Auth |
| Ekspor CSV | **Ditulis ulang** | Ditambah Excel dan PDF |
| Dashboard guru (3 tab dalam satu halaman siswa) | **Dipisah** | Halaman guru/admin tersendiri |

---

## 6. Perbaikan mendesak untuk v1 (opsional)

v1 sedang dipakai untuk ulangan sungguhan, dan v2 baru selesai setelah beberapa fase. Ada perbaikan kecil di sisi server yang bisa mengurangi risiko H-1, H-2, dan H-3 tanpa menyentuh frontend atau menunggu v2. Ini **bukan bagian rencana v2** dan tidak akan dikerjakan tanpa persetujuanmu.

| Perbaikan | Isi | Risiko |
|---|---|---|
| A | Ganti password guru sekarang (kamu sendiri di dashboard, tanpa kode) | Tidak ada |
| B | `submit-exam` menolak atau menandai pengumpulan setelah `ends_at` + toleransi (usulan 2 menit) | Kecil; perlu diuji agar siswa yang sah tidak ditolak |
| C | `start-exam` menolak nama + kelas yang sudah punya sesi terkumpul (batas 1 kali) | Sedang: tanpa jalan remedial, guru harus menghapus hasil lama untuk mengizinkan ulang |
| D | Pembatasan laju login guru | Kecil |

Perbaikan dilakukan di proyek Supabase v1 yang sedang live, jadi sebaiknya di luar jam ujian dan diuji dulu.

---

## 7. Langkah berikutnya

1. Jawab ulang D-01 dengan fakta pada K-1, lalu sesuaikan Dokumen Desain (termasuk istilah kesulitan pada K-2).
2. Putuskan apakah perbaikan mendesak di bagian 6 dikerjakan.
3. Setujui Draf 3 untuk memulai Fase 0 (mockup) dan Fase 1 (proyek dev, skema, Supabase Auth).
