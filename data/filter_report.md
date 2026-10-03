# Filter report

Input: `lichess_db_puzzle.csv.zst` | seed: 42 | target: 100,000 | selected: **100,000** | invalid lines dropped: 0

## Hard-filter funnel

| Stage | Remaining |
|---|---:|
| All puzzles | 6,100,952 |
| Rating >= 1200 | 3,833,949 |
| RatingDeviation <= 80 | 2,660,031 |
| Popularity >= 80 | 2,395,165 |
| NbPlays >= 1000 | 1,244,885 |
| 4-16 plies | 1,211,434 |
| Not mateIn1 / oneMove | 1,211,433 |

## Primary theme allocation

`pool` = eligible puzzles carrying the tag; `selected` = puzzles whose primary theme it is; `all` = the theme's whole remaining pool was taken.

### core tactics (24,991)

| Theme | Weight | Pool | Selected | |
|---|---:|---:|---:|---|
| fork | 8 | 176,247 | 6,449 |  |
| pin | 6 | 102,391 | 4,837 |  |
| sacrifice | 6 | 135,383 | 4,837 |  |
| discoveredAttack | 5 | 82,185 | 4,031 |  |
| skewer | 4 | 28,674 | 3,225 |  |
| discoveredCheck | 2 | 31,181 | 1,612 |  |

### secondary tactics (22,976)

| Theme | Weight | Pool | Selected | |
|---|---:|---:|---:|---|
| deflection | 4 | 72,052 | 3,225 |  |
| attraction | 4 | 80,806 | 3,225 |  |
| trappedPiece | 3 | 27,033 | 2,419 |  |
| intermezzo | 3 | 23,060 | 2,419 |  |
| clearance | 3 | 21,676 | 2,419 |  |
| capturingDefender | 2.5 | 14,607 | 2,015 |  |
| hangingPiece | 2 | 39,615 | 1,612 |  |
| interference | 2 | 7,025 | 1,612 |  |
| xRayAttack | 2 | 5,748 | 1,612 |  |
| doubleCheck | 2 | 8,910 | 1,612 |  |
| attackingF2F7 | 1 | 5,370 | 806 |  |

### subtle moves (14,411)

| Theme | Weight | Pool | Selected | |
|---|---:|---:|---:|---|
| quietMove | 5 | 50,544 | 4,031 |  |
| defensiveMove | 4 | 76,444 | 3,225 |  |
| zugzwang | 3 | 13,290 | 2,418 |  |
| collinearMove | all | 2,208 | 2,174 | all |
| enPassant | all | 2,045 | 2,039 | all |
| castling | all | 342 | 342 | all |
| underPromotion | all | 182 | 182 | all |

### attack & pawns (6,852)

| Theme | Weight | Pool | Selected | |
|---|---:|---:|---:|---|
| kingsideAttack | 2 | 86,205 | 1,613 |  |
| queensideAttack | 1 | 16,434 | 806 |  |
| exposedKing | 1.5 | 54,524 | 1,209 |  |
| advancedPawn | 2 | 90,289 | 1,612 |  |
| promotion | 2 | 32,184 | 1,612 |  |

### mates (23,112)

| Theme | Weight | Pool | Selected | |
|---|---:|---:|---:|---|
| mateIn2 | 3 | 116,280 | 2,419 |  |
| mateIn3 | 3 | 54,225 | 2,419 |  |
| mateIn4 | 1.5 | 13,243 | 1,209 |  |
| mateIn5 | 0.6 | 2,627 | 484 |  |
| backRankMate | 1.5 | 6,605 | 1,209 |  |
| operaMate | 0.5 | 7,298 | 403 |  |
| pillsburysMate | 0.5 | 7,332 | 403 |  |
| epauletteMate | 0.4 | 2,686 | 322 |  |
| smotheredMate | all | 881 | 881 | all |
| cornerMate | all | 1,767 | 1,761 | all |
| triangleMate | all | 1,707 | 1,707 | all |
| hookMate | all | 1,576 | 1,573 | all |
| anastasiaMate | all | 1,290 | 1,290 | all |
| killBoxMate | all | 1,248 | 1,246 | all |
| morphysMate | all | 1,183 | 1,181 | all |
| swallowstailMate | all | 1,082 | 1,082 | all |
| arabianMate | all | 1,004 | 1,004 | all |
| blindSwineMate | all | 809 | 808 | all |
| vukovicMate | all | 620 | 614 | all |
| dovetailMate | all | 601 | 601 | all |
| balestraMate | all | 370 | 370 | all |
| bodenMate | all | 99 | 99 | all |
| doubleBishopMate | all | 27 | 27 | all |

### endgames (6,045)

| Theme | Weight | Pool | Selected | |
|---|---:|---:|---:|---|
| rookEndgame | 2 | 58,288 | 1,612 |  |
| pawnEndgame | 2 | 45,195 | 1,612 |  |
| bishopEndgame | 1 | 17,922 | 806 |  |
| knightEndgame | 1 | 10,223 | 806 |  |
| queenEndgame | 1 | 12,505 | 806 |  |
| queenRookEndgame | 0.5 | 5,236 | 403 |  |

### untagged (1,613)

| Theme | Weight | Pool | Selected | |
|---|---:|---:|---:|---|
| mixed | 2 | 298,576 | 1,613 |  |

## Rating bands

| Band | Count |
|---|---:|
| 1200-1399 | 17,726 |
| 1400-1599 | 18,264 |
| 1600-1799 | 17,863 |
| 1800-1999 | 16,627 |
| 2000-2199 | 15,235 |
| 2200+ | 14,285 |

## Solution length

| Plies (incl. setup) | Player moves | Count |
|---:|---:|---:|
| 4 | 2 | 43,354 |
| 6 | 3 | 41,022 |
| 8 | 4 | 11,633 |
| 10 | 5 | 2,993 |
| 12 | 6 | 738 |
| 14 | 7 | 190 |
| 16 | 8 | 70 |

## Game phase

| Phase | Count |
|---|---:|
| middlegame | 47,930 |
| endgame | 47,895 |
| opening | 4,175 |

## Tag coverage (any tag)

| Tag | Puzzles |
|---|---:|
| middlegame | 47,930 |
| endgame | 47,895 |
| short | 43,335 |
| crushing | 41,078 |
| long | 41,012 |
| mate | 30,804 |
| advantage | 28,083 |
| sacrifice | 21,410 |
| mateIn2 | 17,290 |
| veryLong | 15,618 |
| fork | 14,660 |
| master | 12,388 |
| kingsideAttack | 10,536 |
| attraction | 10,513 |
| mateIn3 | 9,714 |
| advancedPawn | 9,357 |
| pin | 8,990 |
| discoveredAttack | 8,754 |
| exposedKing | 7,215 |
| defensiveMove | 7,135 |
| deflection | 6,944 |
| quietMove | 6,400 |
| discoveredCheck | 5,842 |
| pawnEndgame | 5,369 |
| rookEndgame | 4,805 |
| opening | 4,175 |
| skewer | 3,487 |
| promotion | 3,315 |
| clearance | 3,042 |
| mateIn4 | 2,979 |
| hangingPiece | 2,963 |
| intermezzo | 2,960 |
| trappedPiece | 2,613 |
| zugzwang | 2,506 |
| doubleCheck | 2,501 |
| collinearMove | 2,208 |
| capturingDefender | 2,047 |
| enPassant | 2,045 |
| queensideAttack | 1,960 |
| cornerMate | 1,767 |
| xRayAttack | 1,738 |
| triangleMate | 1,707 |
| interference | 1,657 |
| bishopEndgame | 1,602 |
| hookMate | 1,576 |
| backRankMate | 1,538 |
| masterVsMaster | 1,328 |
| queenEndgame | 1,293 |
| anastasiaMate | 1,290 |
| killBoxMate | 1,248 |
| morphysMate | 1,183 |
| operaMate | 1,088 |
| knightEndgame | 1,085 |
| swallowstailMate | 1,082 |
| arabianMate | 1,004 |
| attackingF2F7 | 897 |
| smotheredMate | 881 |
| pillsburysMate | 866 |
| mateIn5 | 821 |
| blindSwineMate | 809 |
| vukovicMate | 620 |
| dovetailMate | 601 |
| queenRookEndgame | 588 |
| epauletteMate | 495 |
| balestraMate | 370 |
| castling | 342 |
| underPromotion | 182 |
| bodenMate | 99 |
| superGM | 52 |
| doubleBishopMate | 27 |
