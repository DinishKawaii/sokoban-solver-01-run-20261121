# Sokoban solver — make.fun sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/DinishKawaii/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/DinishKawaii/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Satu program (`main.ts`, Node 22) yang menjawab 5 level Sokoban dalam sekali
jalan: baca `/input/<id>/level.txt`, tulis `/output/<id>/solution.txt`.

Cara kerja: tiap level terbelah menjadi ruangan-ruangan kecil yang saling
lepas (kotak tak pernah keluar dari ruangannya), jadi tiap ruangan
diselesaikan sendiri dengan pencarian breadth-first atas dorongan
(push-optimal), lalu gerakan pemain dirangkai antar ruangan. Dua pemangkas
menjaga pencarian tetap kecil: kotak hanya boleh didorong ke petak "hidup"
(yang masih bisa mencapai gawang) dan dorongan yang membekukan kotak di blok
2x2 dibuang. Kalau breadth-first menyerah di satu ruangan, pencarian
best-first (A*) mencoba lagi demi solusi apa pun yang valid.

Hasil di set latihan: skor 1.000.000 (semua level selesai tepat di jumlah
dorongan optimal P*).
