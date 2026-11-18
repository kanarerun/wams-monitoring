# WAMS — Third-Party Software & AI Component Documentation

This document lists all third-party and AI components used in WAMS (Web-based
Academic Monitoring System), their licenses, sources, and recommended citations
for academic/thesis documentation.

---

## 1. AI Components (Camera Proctoring)

The real-time camera proctoring module performs **fully client-side face
detection and landmark estimation** — video frames never leave the browser for
inference.

### 1.1 face-api.js

| Property | Value |
|---|---|
| Version | 0.22.2 |
| License | **MIT License** |
| Author | Vincent Mühler (justadudewhohacks) |
| Source | https://github.com/justadudewhohacks/face-api.js |
| Bundled as | `WAMS/student/face-api.min.js` |

face-api.js is a JavaScript face-recognition library built on top of
TensorFlow.js. WAMS uses two of its neural networks, with weights bundled
locally under `WAMS/student/models/`:

- **Tiny Face Detector** (`tiny_face_detector_model-*`) — a lightweight
  convolutional neural network for real-time face detection.
- **Face Landmark 68** (`face_landmark_68_model-*`) — 68-point facial
  landmark estimation, used for head pose / gaze direction checks.

Both the library and the model weights are distributed under the MIT License
as part of the face-api.js repository.

**MIT License text (face-api.js):**

```
MIT License

Copyright (c) 2018 Vincent Mühler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 1.2 TensorFlow.js (bundled inside face-api.js)

| Property | Value |
|---|---|
| License | **Apache License 2.0** |
| Author | Google LLC / the TensorFlow Authors |
| Source | https://github.com/tensorflow/tfjs |

face-api.js bundles a modified TensorFlow.js runtime for in-browser inference.

### 1.3 Underlying research (academic citations)

- **Tiny Face Detector** — architecture based on YOLOv2-tiny:
  J. Redmon and A. Farhadi, *"YOLO9000: Better, Faster, Stronger"*, CVPR 2017.
  (The face weights retrained in face-api.js are MIT-licensed.)
- **Face Landmark 68** — based on dlib's ERT landmark model, trained on the
  iBUG 300-W dataset:
  V. Kazemi and J. Sullivan, *"One Millisecond Face Alignment with an Ensemble
  of Regression Trees"*, CVPR 2014.
  *Note: the iBUG 300-W dataset is distributed for non-commercial research
  use, which is consistent with academic thesis work.*

---

## 2. Frontend Libraries

| Component | Bundled as | License | Source |
|---|---|---|---|
| jsPDF | `WAMS/vendor/jspdf.umd.min.js` | MIT | https://github.com/parallax/jsPDF |
| Chart.js | `WAMS/vendor/chart.umd.min.js` | MIT | https://github.com/chartjs/Chart.js |
| Inter font | Google Fonts (CSS link) | SIL Open Font License 1.1 | https://rsms.me/inter/ |

---

## 3. Backend / Runtime Dependencies

Project license: **MIT** (see `package.json`).

Direct dependencies and their licenses (from the lockfile):

| Package | Purpose | License |
|---|---|---|
| express | HTTP server / API | MIT |
| @libsql/client | Turso (SQLite cloud) database client | MIT |
| bcrypt | Password hashing | MIT |
| cors | Cross-origin resource sharing middleware | MIT |
| dotenv | Environment configuration | BSD-2-Clause |
| jsonwebtoken | JWT authentication | MIT |
| Node.js (runtime) | JavaScript runtime | MIT |

Full transitive dependency licenses (all permissive):
MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0. No copyleft (GPL) licenses
are present in the dependency tree.

---

## 4. Suggested Thesis Text

> The real-time proctoring module uses **face-api.js v0.22.2** (MIT License),
> a JavaScript face-recognition library built on **TensorFlow.js** (Apache
> License 2.0). It runs the **Tiny Face Detector** convolutional neural network
> and the **Face Landmark 68** network entirely client-side, meaning face
> detection and head-pose analysis are performed in the browser and no video
> frames are uploaded for AI inference. Model weights are distributed under
> the MIT License as part of the face-api.js repository; the landmark model's
> training data derives from the iBUG 300-W dataset (Kazemi & Sullivan, 2014),
> distributed for non-commercial research use, which is appropriate for this
> academic context. Reporting features use **jsPDF** (MIT) for PDF generation
> and **Chart.js** (MIT) for dashboard visualizations. The system backend is
> built on **Node.js** and **Express** (MIT), with **Turso/libsql** as the
> database client (MIT), and is released under the MIT License.
