# 🎮 SockTank

Multiplayer tank battle game via WebSockets. 2–4 players.

## Setup

```bash
cd socktank
npm install
npm start
```

Terminal will show:
```
Game screen: http://localhost:3001
Phones:      http://192.168.x.x:3001/join
```

## How to Play

1. **Game screen** (laptop): Open `http://localhost:3001` → Create Game → Choose 2/3/4 players
2. **Each phone**: Open the phone URL → Join Game → Enter the 6-digit code
3. Once all players joined, press **Ready** on the game screen
4. Countdown from 7, then battle!

## Controls (D-Pad on phone)

- **▲ Forward** — move tank in facing direction
- **▼ Backward** — reverse
- **◄ Left** — rotate tank left
- **► Right** — rotate tank right
- **⊕ Center** — SHOOT (5 second reload after firing)

## Rules

- Hit enemy tanks with your bullet to score points
- Bullets ricochet off walls (up to 5 bounces), then disappear
- First tank to receive **10 hits** is eliminated
- Last tank standing wins
- Friendly fire is ON — your own ricochets can hurt you!
- Reloading: tank shows RELOAD state for 5 seconds after shooting

## Tank Colors

| Tank  | Color    |
|-------|----------|
| ATANK | #854646  |
| BTANK | #103430  |
| CTANK | #8B4ACF  |
| DTANK | #2A6B8A  |

## Notes

- Runs on port **3001** (SockPong uses 3000, no conflict)
- Room codes are unique — no two active rooms share a code
- Rooms auto-expire after **15 minutes of inactivity**
