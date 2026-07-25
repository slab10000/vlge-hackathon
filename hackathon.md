# Open World Hackathon — VLGE

Build the future of physical AI through believable worlds, data-minded social environments, and original experiments.

- **Date:** Saturday, 25 Jul 2026
- **Location:** San Francisco — 3001 19th St
- **Build window:** 10:00–18:30 · Submissions close **18:30 PT (hard deadline)** — but see schedule warning below
- **Prizes:** Up to $10,000 worth (no per-track breakdown published)
- **Host:** VLGE AI (human behavioral layer for physical AI: spatial + human data with traceable provenance) · Hosted by Evelyn Mora, Roland Graser, Cesca Centini · Supported by The Residency
- **Event page:** https://luma.com/ttc3tp9d · also https://vlge.com/events
- **Framing (vlge.com/events):** *"Physical AI is bottlenecked by data. We're opening it up."* Teams build with a proprietary human-behavioral dataset provided by VLGE, 3D Gaussian Splatting, and VLGE's 3D template library.

## Schedule

| Time | What |
|---|---|
| 09:00 | Doors open — check in, join support channels |
| 10:00 | Kickoff — tracks, datasets, rules, release forms |
| 13:00 | Lunch, provided (keep one teammate near the build if processing) |
| 17:00 | Mentor check-ins — show core loop, ask one focused question |
| 18:30 | **Submissions close** (Google Form received by 18:30 PT) |
| 19:00 | Demos |
| 19:45 | Judging + prizes |
| 20:00 | Close — save links, exchange contacts |

> ⚠️ **Schedule conflict between sources.** The handbook + Luma say submissions close 18:30. But vlge.com/events shows: check-in 09:00, opening 09:30, building 10:20–12:30 and 13:45–16:30, **physical-AI panel 12:30–13:15**, **final build/submission 17:00–18:00**, demos & judging 18:30–19:15, awards 19:45–20:15. Confirm at kickoff; plan to be submittable by **18:00** and treat 18:30 as the absolute latest. Demo timing may also be adjusted at kickoff based on submission count.

## Judges

| Judge | Affiliation |
|---|---|
| Evelyn Mora | VLGE (CEO) |
| Drew Jaegle | Prometheus |
| Paige Bailey | DeepMind |
| Ignacio Lopez-Francos | NASA / SETI |
| Riya Dashoriya | Meta |
| Nureldin Mohamed | Harvard Wyss Institute |
| Harsh Sharma | NVIDIA |

Track presentations by Roland Graser. **Read of the panel:** it skews robotics / world models / embodied AI. Projects that treat the world as a *training-data instrument for physical AI* (imitation data, behavioral telemetry, sim-to-real story) will land better than pure game/world demos. A polished playable world **plus one visible "data layer" screen** (live telemetry visualization) likely beats a deep but invisible backend.

## Who VLGE is (and what they reward)

Understanding the host is the meta-strategy — their thesis is the judging lens:

- Positioning: *"The human behavioral data layer powering the post-training supply chain for physical AI"* — "where worlds are built, played, and captured." Real people play in browser worlds; sessions become consent-based, GDPR-compliant spatial + behavioral training data sold to world-model, robotics, and embodied-AI builders.
- Marketing claims (their numbers): 3M hours build data, 4M+ hours play data, ~164K datapoints per hour per session.
- **Data products they sell** (vlge.com/ai "Labs"): 3D environments (watertight geometry, materials, navmesh, floor plans) · 3DGS captures (splats, radiance fields, multi-view, intrinsics, depth, masks, 2D/3D boxes) · spatial metadata (labelled zones, object semantics, adjacencies, sightlines) · **continuous event streams (timestamped pose, gaze, velocity, dwell, build + interaction events, JSON export)** · physics interactions with full-body motion capture down to fingers · custom data collection. Also: VLA task layers, multi-agent synchronized sessions, spatial-intelligence benchmarks.
- **Protege partnership** (June 2026): data licensing/monetization, behavioral metadata standards, "embodied retail intelligence." Signals captured: movement trajectories, **hesitation loops**, exploration patterns, object interactions, spatial decision-making. Forbes coverage highlights "hesitation scores" and the thesis that naturally-motivated play data beats annotator-instructed data.
- Verticals: Commerce (store-layout heatmaps, dwell, pause/miss detection, routes, sightlines; clients incl. NYX, Lancôme) and Real Estate (digital twins; metrics like path straightness, dwell clusters, radius of gyration).
- CEO quote: *"AI systems need to understand not only what humans say, but how humans move, hesitate, explore, compare, and decide within environments."*
- Background (secondhand/unverified): ~$4M raised (Venture Reality Fund, L'Oréal BOLD, British Fashion Council), formerly "Digital Village," Epic MegaGrant recipient, founder previously created Helsinki Fashion Week.

## Tracks

### 1 · Open Narrative (story + challenge)
Believable real-world scenario or puzzle inside VLGE.
- Escape rooms, navigation challenges, training scenarios
- Use 3D Gaussian Splats or VLGE templates
- Prioritize atmosphere, clarity, satisfying progression
- **Success:** a stranger can enter, understand the goal, and finish.

### 2 · VLGE Together (social + behavior)
Social/multiplayer world in **Unity (preferred)**, VLGE, or another engine where interaction produces useful data for robotics / physical AI / behavior modeling.
- Meaningful cooperation, competition, coordination, or shared exploration
- Identify the robotics/physical-AI use case and valuable behaviors/telemetry
- Design so future sessions could produce useful, consented data (logging optional)
- **Success:** purposeful social interaction with a credible future data-collection use.

### 3 · Free Track (open experimentation)
Original use of VLGE tools, data, or features beyond the other tracks.
- World generation, behavioral telemetry, spatial capture
- Research demos, simulations, utilities, new formats
- State the hypothesis; show what the prototype proves
- **Success:** reveals a capability or use case the organizers didn't expect.

## The VLGE platform (what you can actually build with)

Fully **browser-based, no-code** (Unity URP compiled to WebGL — no installs for judges). Three parts: **V-BLDR** (in-browser world editor), **V-CTRL** (dashboard: worlds, assets, teams, analytics, billing — vctrl.vlge.com, login required, Google SSO, free trial), **ARYA** (AI assistant).

**Building**
- Start from blank world, template, or duplicate; built-in Object Library (Nature, Interior, Fashion, Functional…); drag-drop with gizmo + surface snapping; Hierarchy + Inspector panels; custom skybox; post-processing presets + per-parameter control.
- Uploads via browser: **GLB** (3D), PNG/JPG, MP3, MP4. Custom Unity template workflow accepts OBJ/FBX (only workflow needing Unity).
- **ARYA AI:** text-to-3D, image-to-3D ("Turn to 3D"), auto-tagging; costs AI credits (tier-based); play-mode toggle `K`.
- **Multibuilder:** up to 7 people editing the same world in real time — whole team builds simultaneously.

**No-code interaction primitives (your logic toolbox)**
- URL/portal on any object (`E` interact; opens same page / new tab / **overlay window on top of the world** — i.e., you can embed your own web app inside the experience)
- Event Volume Boxes (trigger zones on enter/interact → play animations, show/hide objects, start audio/video)
- Built-in games: **Collectible Game** (item count, scoring, styling) + **Paintball** and **Marathon** (from release notes — ready-made competitive mechanics you can reskin)
- VLGE Event System (dynamic world interactions), video screens, audio emitters (2D global / 3D spatial), animated GLB objects (auto-detected, loop/one-shot, triggerable), Custom UI (HUD, buttons, quest text panels → can trigger anything)

**Multiplayer + avatars**
- Worlds are multiplayer by default; real-time avatar sync; voice chat (VoIP, `M` mute), text chat (`T`/`B`), user list. Ready Player Me avatars (switch outfits in-world, `N`).
- If you update a live world, connected users must reload (desync risk during demos).

**Publishing + data**
- "Save / Go Live" publishes instantly to a shareable link; Public / Private / Unlisted; timestamped drafts with rollback.
- **"Update JSON": the entire world save is exposed as JSON you can copy out and paste back** → programmatic/LLM world generation and remixing is possible without an API.
- **Built-in analytics per world:** visitors, time spent, entry/exit points, interaction usage, device/browser — **raw data downloadable via the Project Data Page**. Built-in session recording (saves video locally).

**Hard limits (Asset Guide)**
- ~150,000 vertices/scene; ~<100k polys viewed per frame; props 100–1k, medium 1k–5k, architecture 5k–50k polys
- Textures: 2048×2048 desktop, 512×512 mobile; builds: **250 MB desktop, 90 MB mobile**
- **Only 3 dynamic lights** (WebGL) — use baked lighting; no tessellation, no native LODs
- Desktop + mobile browsers; **no VR/headset support documented**

**Play controls:** WASD move, Space jump, `E` interact, hold Ctrl to free cursor, `M` mic, `T`/`B` chat, `J` first/third person, `K` ARYA, `N` avatar.

**Docs are LLM-friendly:** full index at `vlge.gitbook.io/vlge-documentation/llms.txt`; append `.md` to any docs URL for raw Markdown — feed them straight to Claude for build help.

> ⚠️ **Splat caveat:** "Add Splat," "Generate Collider from splat," and the "World 50" template exist **only in the organizers' Google Docs** — the entire public GitBook (112 pages) and release-notes archive never mention splats. Treat the splat workflow as unreleased/undocumented; expect organizer hand-holding, and verify it works before betting the project on it. Public docs also trail the live build (~1 year stale: latest release notes 07-08-2025), so the limits above may have moved in either direction.

## Build path

1. **Engine** — Track 2: Unity (preferred) / VLGE / other. Tracks 1 & 3: V-CTRL templates, supplied maps, or World 50.
2. **Target** — define the user and the robotics/physical-AI problem (Track 2: name the useful behaviors/telemetry).
3. **Core loop** — smallest runnable scenario: clear start, objective, interaction, end state.
4. **Design + test** — test in Play Mode.
5. **Package** — shareable world/build, setup instructions, demo media.

**VLGE builder learning path (handbook p4):** World Builder basic layout → add an object + use the inspector → advanced asset types + model generation → add image, video, text or game → post-processing effects + Play Mode.

**First 60 minutes:** pick track (0–10) → core interaction in one sentence (10–20) → open V-CTRL, pick template/map (20–35) → smallest playable loop (35–50) → test in Play Mode, assign owners (50–60).
**Suggested roles:** Builder · Interaction/logic · Visuals · Demo/submission.

## Optional: Gaussian Splat capture (build from a real place)

### Path A — capture your own
- 4K/**30fps** (not 60, never 1080p); one continuous ~15-min clip per location; press record once and keep rolling
- **Lock exposure, white balance, focus before recording** (iPhone: tap-hold for AE/AF lock; Android: Pro mode) — auto-adjust mid-clip ruins the footage; free up storage first
- Even, soft light (overcast/open shade; indoors turn all lights on); avoid direct sun and high contrast; record a test clip and inspect it zoomed-in first
- Slow overlapping loops at **half walking pace**, 0.5–1 m from walls/furniture, at three heights (~1 m waist, ~1.5 m chest, ~2 m overhead) tilting slightly down then up at each height; aim for **50–70% frame overlap**; keep moving, never spin in place
- Alternative: three full 360° perimeter walks at level / tilted-down / tilted-up
- Good venues: churches, restaurants, stores, hotels, contained spaces — avoid duplicating other teams' locations
- **Quality gate:** if the splat comes out wrong, the only remedy is a full recapture

### Path B — supplied maps
- 3 Gaussian Splat `.ply` maps in the Drive folder (see inventory below); use these when speed matters; download only what you need

### Teleport (Varjo) — the processing service, in detail
- **Inputs:** ZIP of 50–2,000 photos (PNG/JPEG/HEIC, ≤5 GB, images at ZIP root for web upload) · or one MP4/MOV video 30 s–15 min ≤5 GB · **or a raw Gaussian-splat `.ply` uploaded directly**. No fisheye/360 input. iOS capture app exists (iOS 17+, free); no Android app — Android users upload via web.
- **Frame guidance:** 250–1,000 frames recommended (2,000 max; >2,000 tends to fail, <100 insufficient). Their capture advice: outside-in path (perimeter first, then inward), portrait orientation, smooth sweeps, nothing moving in the scene.
- **Processing:** officially **30 min–24 h** (organizers' 2–4 h estimate sits inside this; plan for worse). Multiple captures process in parallel.
- **Key hack: `.ply` uploads are free, unlimited, don't consume scan allowance, and skip reconstruction** → you can upload the supplied gs_map `.ply` files to Teleport to mint Share IDs instantly. Test with `gs_map_2.ply` (638 MB, the smallest) first.
- **Pricing:** free account ≈ 5 scans (launch-era: free tier can't export PLY); Professional from ~$30 (pay-per-capture; PLY export, embeds, API). Ask organizers if teams get Pro accounts.
- **Extras if useful:** full REST API with chunked upload + **webhooks** (get pinged when processing completes instead of polling), Teleport.js viewer SDK, iframe embeds, Portals/Virtual Tours for chaining multi-room scenes, share links viewable on any browser.
- Data ownership: "You own your data. We don't publish it or train AI models unless you explicitly opt in."

### Import workflow (organizer doc)
1. Teleport account → Captures → Upload Capture (ZIP) → wait (~2–4 h claimed) → **view and verify the splat**
2. Copy the **Share ID** from the splat info panel
3. In VLGE: create world from the black template **"World 50"** → **Add Splat** → paste Share ID (loads progressively)
4. **Generate Collider from splat** (auto-generated) → now playable; mix in regular VLGE assets

> **Important pipeline note:** the supplied `.ply` files can't go into VLGE directly (browser uploads are GLB-only, 250 MB cap). The route is `.ply` → Teleport upload (free) → Share ID → World 50 "Add Splat".
> **Timebox it:** splat not ready/correct by mid-afternoon → switch to a supplied map/template. A working experience scores better than an unfinished capture.

## What's actually in the Drive folder ("VLGE Sessions - Hackathon")

Public folder, no sign-in. All items last modified Jul 23. **Total ~12 GB if you grab everything — download only what you need.**

| Item | Contents |
|---|---|
| GS Map 1 | `gs_map_1.ply` **3.3 GB** + Edit/Play session recordings |
| GS Map 2 | `gs_map_2.ply` **638 MB** + `egocentric_view.mp4` (264 MB, the capture walkthrough) + sessions |
| GS Map 3 | `gs_map_3.ply` **2.2 GB** + sessions |
| 3D Map 1–3 | ⚠️ **No mesh/model files at all** — only session recordings. Ask organizers where the actual 3D maps live. |
| 2 Google Docs | The capture + import guides summarized above |

**The hidden dataset:** every map folder has `Edit Mode/{Json,Video}` and `Play Mode/{Json,Video}` — **97 telemetry JSON files** (~16–39 MB each, one per ~30 s of session, named `20260629T170918638_fe09_improved.json`) plus 12 screen-recording MP4s of VLGE edit/play sessions from Jun 29–Jul 6, 2026. Edit sessions run 2–3× longer than Play sessions. This is almost certainly the "proprietary human-behavioral dataset" from the event page — likely VLGE's event-stream format (pose/gaze/dwell/interactions per their Labs page). **Nobody has inspected the schema yet — downloading one JSON and mapping its fields is the highest-value first move for any data-track project.**

## Unity Robotics Hub (Track 2 ammunition)

- Provides: **URDF-Importer** (load real robot description files as physics-accurate ArticulationBody robots — pure Unity package, **no ROS needed**), ROS-TCP-Connector/Endpoint (bidirectional Unity↔ROS messaging), MoveIt pick-and-place tutorial (Niryo One arm), Nav2 SLAM example (Unity replacing Gazebo), object-pose-estimation demo (synthetic training data).
- Status: maintenance mode (last feature release Feb 2022, ROS2 Foxy era) — use as the *proven integration layer* in your story, not your critical path. Full ROS setup is multi-part with Docker; realistic as demo garnish only.
- **ML-Agents is actively maintained (2026)** — the live piece for a "humans play, robots learn" imitation-learning story (behavioral cloning / GAIL).
- Cheap credibility trick: serialize recorded interactions in ROS message schemas (JointState, Twist, TF) so the pitch can say "one flag away from a ROS bag."

## Brainstorm angles (synthesized from all research)

**The meta-insight:** VLGE's judges and business want worlds that *generate valuable human-behavior data*. Design the world as a task generator for physical-AI training data, and make the data visible in the demo.

**Track 1 — Open Narrative**
- Splat a real SF venue (or use a supplied GS map) + escape/navigation puzzle whose solution telemetry maps to robot-relevant skills (fetch, sort, sequence, navigate); show the exported event stream as a mini-dataset with provenance metadata.
- "Time machine": two captures of one place, swap Share IDs to toggle scene versions.
- Museum/training tour: trigger-zone narration (3D audio), video walls, quest UI — all no-code.

**Track 2 — VLGE Together**
- Cooperative manipulation/handover world (two players must coordinate object handoffs) → exactly the multi-human synchronized data VLGE's Labs page sells; household-chores or warehouse co-op theming.
- Human-robot social navigation: URDF robot navigating among real players; export crowd trajectories as a social-nav benchmark.
- "Teach-the-robot": robot avatar controlled by players; every grasp/navigation logs demonstration trajectories (URDF-Importer alone makes this a one-day build, zero ROS).
- Reskin built-in Paintball/Marathon/Collectible games instead of building mechanics from scratch.
- Live bridge wow-factor: stream player trajectories to rviz/ROS topic in real time via ROS-TCP.

**Track 3 — Free Track**
- **Parse the 97 supplied telemetry JSONs** → session replay tool, dwell/hesitation heatmaps, "ghost replay" of real sessions inside the rendered splat scene, Edit-vs-Play behavioral comparison across mesh vs splat worlds.
- Hesitation analytics: turn event streams into behavioral embeddings (hesitation score, exploration entropy) — directly echoes VLGE's Forbes narrative.
- **LLM world generation via "Update JSON":** have Claude generate/mutate the world-state JSON and paste it back — procedural world building without an API.
- Agentic commerce: LLM shopping agent inside a store world; compare its trajectories to human telemetry ("human-vs-agent behavioral gap" benchmark) — aligns with the Protege retail partnership.
- Provenance layer: per-session consent receipts / C2PA-style signing of exported behavioral JSON — hits "traceable provenance" verbatim.
- Capture-coach app: real-time phone HUD enforcing the capture rules (speed, heights, overlap, no spinning) — fixes the pipeline's "only remedy is recapture" pain.
- Splat tooling: compress/stream the huge `.ply` files (.splat/.spz) in a web viewer; auto-generate minimaps/navmeshes/occupancy grids from splat point data.
- Package your world + collected traces as a small standardized benchmark with an eval script (appeals to DeepMind/Meta judges).

**Demo advice that recurs across sources:** lead with the playable world, then show one screen of live telemetry/data. Update-JSON, analytics download, and session recording are built in — use them for the data story instead of building infra.

## Submission (one form per team, by 18:30 PT — aim for 18:00)

**Form:** https://forms.gle/AgyhxvcXJGFNj9PC8

Required fields:
- Team name + participant names
- Project title + track + engine
- One-sentence pitch
- Judge-accessible world/build link
- 60–90 s backup demo video
- Three strongest screenshots
- Setup / controls / expected outcome
- Track 2: future data-collection plan
- External assets, datasets, AI tools used
- Repo/notes + known device requirements

**Demo format:** 3 min demo + 2 min Q&A (may be adjusted at kickoff based on submission count). Lead with the playable experience: problem → interaction → outcome. Keep backup video locally available.

## Judging (100 points)

| Points | Criterion |
|---|---|
| 25 | Experience + usability — clear goal, intuitive controls, coherent flow, satisfying result |
| 25 | Technical execution — stable build, reliable interactions, thoughtful choices |
| 20 | Track fit + impact |
| 20 | Originality — distinct concept, surprising mechanic, fresh use of spatial/behavioral data |
| 10 | Demo + reproducibility — concise story, judge-ready link, test instructions, attribution |

- **Track lens:** Open Narrative → believability + progression · VLGE Together → social interaction + usefulness/feasibility of data-collection concept · Free Track → clarity of hypothesis + platform-expanding insight.
- **Tie-breakers:** working live build · stronger core interaction · clearer provenance · greater readiness to share.
- **No extra credit for unused features** — spend the last hour on reliability, onboarding, and the demo.

## Rules

- Solo or team; submit once per team; judge-accessible by 18:30 PT.
- Judging covers work built or meaningfully integrated during the hackathon.
- Templates, assets, datasets, AI tools allowed when licensed and disclosed (disclose engine + dependencies).
- No capturing private spaces, identifiable people, or behavioral data without permission.
- No harmful, deceptive, harassing, discriminatory, or rights-infringing content.
- If collecting data: address consent, provenance, and removal of personal identifiers.
- Organizer decisions are final.

## Open questions for organizers (ask at check-in/kickoff)

1. Where are the actual **3D map mesh files**? (The "3D Map" Drive folders contain only session recordings.)
2. Is the 97-file telemetry JSON set the "proprietary human-behavioral dataset"? Is there a **schema doc**?
3. The splat workflow ("Add Splat," "World 50," collider generation) isn't in any public doc — is it live for all accounts, and who helps if it breaks?
4. Do teams get **Teleport Pro accounts**, or should we budget ~$30 / rely on the free 5-scan tier (no PLY export)?
5. Exact submission close: **18:00 or 18:30**? (Sources conflict.)
6. Team size limits and per-track prize breakdown?

## Definition of done

A judge can open it, understand it, and experience the core loop:
- [ ] Runs without builder intervention
- [ ] Clear start, objective, end state
- [ ] Shared world/build link + video demo submitted
- [ ] External assets and AI tools disclosed

## Final 30-minute checklist

- [ ] Freeze features; run the exact path judges will run
- [ ] Open world/build link in a clean environment
- [ ] Verify spawn, controls, objective, end state
- [ ] Track 2: test multiplayer + explain future data plan
- [ ] Capture backup video + strongest screenshots
- [ ] Confirm credits, consent, provenance, disclosures
- [ ] Submit Google Form before 18:30 PT; save confirmation
- [ ] Keep demo open and ready; one-sentence answer to "Why does this matter?"

## Links

### Official event
| Resource | URL |
|---|---|
| Event page (Luma) | https://luma.com/ttc3tp9d |
| Event page (VLGE, has full schedule + judges) | https://vlge.com/events |
| Project submission | https://forms.gle/AgyhxvcXJGFNj9PC8 |
| Maps + shared resources (Drive) | https://drive.google.com/drive/folders/1UG9KbSpQp-ntFher2geb4RfO0hTfezuV?usp=sharing |
| Gaussian Splat capture guide | https://docs.google.com/document/d/1qtf8ghYXmcKncGhKT4uCbrgGJAcQxBv7Nsma7HP4uPU/edit |
| Gaussian Splat import guide | https://docs.google.com/document/d/13ymcrpvhnZbTPPZHCvUSZYzPv30zVAidjfuc7dSnqEA/edit |

### VLGE platform
| Resource | URL |
|---|---|
| Build in V-CTRL (signup: /onboarding/signup, Google SSO) | https://vctrl.vlge.com |
| VLGE guide (video tutorial hub) | https://world.vlge.com/vlge-guide |
| **Full docs (GitBook, 112 pages)** | https://vlge.gitbook.io/vlge-documentation |
| **LLM-readable docs index** (append `.md` to any page) | https://vlge.gitbook.io/vlge-documentation/llms.txt |
| Asset guide (limits, formats) | https://vlge.gitbook.io/vlge-documentation/vlge-asset-guide |
| VLGE Labs / data products | https://vlge.com/ai |
| Release notes archive | https://world.vlge.com/update/production-release-07-08-2025 |
| YouTube tutorial playlist | https://www.youtube.com/playlist?list=PLALN6CgyDdDABHTNnFZc75jciYPkQe0w5 |
| Support | hello@vlge.com |

### Splat pipeline
| Resource | URL |
|---|---|
| Teleport (splat processing) | https://get.teleport.varjo.com |
| Teleport help center (capture best practices) | https://teleport.varjo.com/help/ |
| Teleport API docs (upload, webhooks) | https://teleport.varjo.com/docs/ |
| Teleport pricing | https://get.teleport.varjo.com/pricing |
| Teleport iOS capture app | https://apps.apple.com/us/app/teleport-by-varjo/id6450445339 |
| Teleport Discord | https://discord.gg/zYzNwGdTFw |

### Unity / robotics (Track 2)
| Resource | URL |
|---|---|
| Unity manual | https://docs.unity3d.com/Manual/ |
| Unity Robotics Hub | https://github.com/Unity-Technologies/Unity-Robotics-Hub |
| URDF Importer (no-ROS robot import) | https://github.com/Unity-Technologies/URDF-Importer |
| ML-Agents (actively maintained; imitation learning) | https://github.com/Unity-Technologies/ml-agents |
| Nav2 SLAM example | https://github.com/Unity-Technologies/Robotics-Nav2-SLAM-Example |

### Context on the host
| Resource | URL |
|---|---|
| Protege × VLGE partnership | https://withprotege.ai/articles/news/vlge-partnership-announcement |
| Forbes on VLGE's data thesis (Jun 2026) | https://www.forbes.com/sites/cortneyharding/2026/06/29/the-future-of-ai-training-data-is-human-the-question-is-how/ |

> **Build small. Test early. Make it memorable.**
