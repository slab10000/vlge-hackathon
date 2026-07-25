# piper_x_arm_description

Single Piper-X arm, extracted from the Opalin `cell_v0_4_description` package (left arm chain).

```
piper_x_arm.urdf     11 links, 10 joints
meshes/*.obj + .mtl  visual    (colored)
meshes/*_c.stl       collision
```

Sources: kinematics and visual meshes from `cell_v0_4_description/scene.urdf`; collision geoms,
joint axes, finger coupling, TCP and camera from `cell_v0_4_description/piper_x_left_arm.xml`.

---

## Conventions

**Units** are SI throughout: metres and radians. Meshes are authored in metres (scale 1).

**`rpy`** follows the URDF convention: fixed-axis (extrinsic) XYZ, i.e. `R = Rz(yaw) · Ry(pitch) · Rx(roll)`.
Note the source MJCF uses `euler` with MuJoCo's default `eulerseq="xyz"`, which is *intrinsic* -
the two differ, and every angle in this file has already been converted to the URDF convention.

**`base_link` is the root**, at the origin, with no mount joint baked in. Attach it yourself:

```xml
<joint type="fixed" name="world2arm">
  <parent link="world"/><child link="base_link"/>
  <origin xyz="0.03 0.3 0.026" rpy="0 0 0"/>   <!-- left arm; right arm is y=-0.3 -->
</joint>
```

With that mount the arm inherits the cell world orientation: **+X** into the workspace (toward
the table, away from the mast), **+Y** toward the cell's left arm, **+Z** up. The mount carries
no rotation, so `base_link` axes *are* the cell world axes.

**Link frames are all axis-aligned with `base_link` at `q=0`.** Every joint origin in this file
has `rpy="0 0 0"`, so at the zero configuration all eleven frames share one orientation and
differ only by translation. Rotation is introduced solely by moving joints. This makes `q=0` a
convenient reference pose.

**Visual vs collision origins differ, deliberately.** The `<collision>` meshes sit at identity
origin in their link frame. The `<visual>` meshes carry baked non-identity `origin` transforms -
an artefact of how the coloured OBJs were exported, not geometric meaning. Both land in the same
place (verified below); do not read anything into a visual origin.

---

## Frame tree

```
base_link
└─ joint1 ─ link2
   └─ joint2 ─ link3
      └─ joint3 ─ link4
         └─ joint4 ─ link5
            └─ joint5 ─ link6
               └─ joint6 ─ gripper_body
                  ├─ gripper_left_joint  ─ gripper_left
                  ├─ gripper_right_joint ─ gripper_right   (mimics the left 1:1)
                  ├─ [fixed] ─ camera           wrist D405 body
                  └─ [fixed] ─ gripper_center   TCP, at the fingertips
```

Link origins at `q=0`, relative to `base_link` (all orientations identity):

| Link | Origin @ q=0 |
| --- | --- |
| `base_link` | `0, 0, 0` |
| `link2` | `0, 0, 0` |
| `link3` | `0, 0, 0.119` |
| `link4` | `-0.283586, 0, 0.14783` |
| `link5` | `-0.013788, 0, 0.193502` |
| `link6` | `0.059485, 0, 0.235548` |
| `gripper_body` | `0.097708, 0, 0.203258` |
| `gripper_left` / `gripper_right` | `0.164328, 0, 0.209087` |
| `camera` | `0.119044, 0, 0.282558` |
| `gripper_center` | `0.237299, 0, 0.215472` |

## Joints

| Joint | Type | Axis | Origin rel. parent | Range |
| --- | --- | --- | --- | --- |
| `joint1` | revolute | `0, 0, 1` | `0, 0, 0` | -2.6005 .. 2.6005 |
| `joint2` | revolute | `0, 1, 0` | `0, 0, 0.119` | 0 .. 3.3161 |
| `joint3` | revolute | `0, 1, 0` | `-0.283586, 0, 0.02883` | -2.9671 .. 0 |
| `joint4` | revolute | `0, 1, 0` | `0.269798, 0, 0.045672` | -1.4835 .. 1.4835 |
| `joint5` | revolute | `0.08687, 0, -0.99622` | `0.073273, 0, 0.042046` | -1.4835 .. 1.4835 |
| `joint6` | revolute | `0.99622, 0, 0.08687` | `0.038223, 0, -0.03229` | -2.7925 .. 2.7925 |
| `gripper_left_joint` | prismatic | `0, 1, 0` | `0.06662, 0, 0.005829` | 0 .. 0.05 m |
| `gripper_right_joint` | prismatic | `0, -1, 0` | `0.06662, 0, 0.005829` | 0 .. 0.05 m |

`joint1`-`joint4` are exactly axis-aligned. **`joint5` and `joint6` are not**: both are tilted by
`atan2(0.08687, 0.99622) = 4.98°` in the XZ plane - `joint5` about -Z tilted 5° toward +X,
`joint6` about +X tilted 5° toward +Z. The axes are given normalised here; the MJCF writes them
unnormalised as `0.0872 0 -1` and `1 0 0.0872`.

### Finger coupling

The two fingers are coupled 1:1 by `<mimic>` on `gripper_right_joint`, matching the MJCF
`<equality>` constraint (`polycoef="0 1 0 0 0"`). Their axes are opposed (`+Y` / `-Y`), so they
close symmetrically about the `gripper_body` XZ plane.

**The arm is 7 DOF to command, not 8.** Each finger travels 0..0.05 m, so the jaw opening is
0..0.10 m total. Loaders that ignore `<mimic>` (several do) will report 8 DOF - in that case
drive `gripper_right_joint` with the same value as `gripper_left_joint`.

---

## TCP (`gripper_center`)

The tool centre point, at the **tip of the fingers**. A fixed frame on `gripper_body`:

```
origin rel. gripper_body : 0.139591, 0, 0.012214    (rpy 0 0 0)
origin rel. base_link @ q=0 : 0.237299, 0, 0.215472
```

This is the `left_gripper_center` site from the MJCF. It really is at the fingertips: the
midpoint of the two fingertip faces measures `0.139498, 0.000398, 0.010562` in `gripper_body`
coordinates, agreeing with the site to **1.7 mm** (0.09 mm in X, 0.4 mm in Y, 1.65 mm in Z).

Because the frame is fixed to `gripper_body` and the fingers move symmetrically in ±Y, **the TCP
is invariant to jaw opening** - it stays on the jaw centreline at every aperture. It does not
retract when the fingers open.

Orientation is identity relative to `gripper_body`, which gives the grasp axes directly:

| Axis | Meaning |
| --- | --- |
| **+X** | approach direction - the fingers extend this way |
| **±Y** | jaw closing axis - `gripper_left` moves +Y, `gripper_right` moves -Y |
| **+Z** | normal to the grasp plane |

Use `gripper_center` as the IK target for grasping. `gripper_body` is the flange frame, 139.6 mm
behind it.

---

## Camera (wrist D405)

There are **two distinct frames** here, and conflating them is the easy mistake.

**1. `camera` - the sensor body frame.** A fixed link on `gripper_body`:

```
origin rel. gripper_body : 0.021336, 0, 0.0793   (rpy 0 0 0)
origin rel. base_link @ q=0 : 0.119044, 0, 0.282558
```

Its axes are identical to `gripper_body`'s. This frame is where the D405 *housing* sits - it is
**not** the optical axis, and the camera does not look along its +X.

**2. The optical frame** - rotated with respect to the `camera` link. From the MJCF
`<camera name="left_wrist_camera" euler="0 -1.2057 -1.5708" fovy="58"/>`. The view direction in
`camera`-link coordinates is:

```
[0.934089, 0, -0.357039]      i.e. 20.92° below the link's +X axis
```

So the camera looks forward along the approach direction and tilted down toward the grasp point.

This frame is **not present in the URDF** - URDF has no camera element, so add it if you need it.
Which rotation you want depends on your convention:

| Convention | Axes | `rpy` rel. `camera` link |
| --- | --- | --- |
| ROS optical (`REP 103`) | +X right, +Y **down**, +Z **forward** | `-1.935893 0 -1.570796` |
| MuJoCo / OpenGL | +X right, +Y **up**, -Z **forward** | `1.2057 0 -1.570796` |

Paste-able, in the ROS optical convention (the usual choice for `camera_info`, depth images and
point clouds):

```xml
<link name="camera_optical"/>
<joint type="fixed" name="camera2camera_optical">
  <parent link="camera"/><child link="camera_optical"/>
  <origin xyz="0 0 0" rpy="-1.935893 0 -1.570796"/>
</joint>
```

In that frame the axes resolve, in `camera`-link coordinates, to
`X(right) = [0,-1,0]`, `Y(down) = [-0.357039, 0, -0.934089]`, `Z(forward) = [0.934089, 0, -0.357039]`.

**Intrinsics.** The MJCF specifies only `fovy = 58°` (vertical). That matches the RealSense D405
RGB spec of 87° × 58° (H × V); horizontal FOV follows from your rendered aspect ratio. There are
no distortion coefficients here - for real-hardware work use the per-unit factory calibration
rather than these nominal values.

---

## Collision

Every link carries one `<collision>` mesh at identity origin in its link frame. These are the
same `*_c.stl` meshes the cell's own MuJoCo sim uses, and they are the *same geometry* as the
visuals, so collision and visual coincide exactly (verified to < 1e-8 m; the residual is float32
STL vs float64 OBJ rounding).

They are full-resolution and non-convex (291k faces total). Fine for planning and rough physics;
engines needing convex shapes (Bullet, MuJoCo) will hull or decompose on load. Note that a naive
per-link convex hull is a poor fit for this arm - `link3` and `link4` are slender curved links at
9% and 6% bounding-box fill, so their hulls enclose ~8× the true volume. Use convex
*decomposition* if you need convex parts.

Adjacent links touch by design. Disable these pairs (the MJCF `<contact>` excludes):

```
base_link    <-> link2
link2        <-> link3
link3        <-> link4
link4        <-> link5
link5        <-> link6
link6        <-> gripper_body
gripper_body <-> gripper_left
gripper_body <-> gripper_right
```

`camera` is rigidly fixed to `gripper_body`; exclude that pair too if your checker tests it.

---

## Caveats

**Inertias are placeholders**, inherited from the source: every link has `ixx=iyy=izz=0.001`
regardless of size, and the inertial origin is at the link origin rather than the centre of mass.
Masses are real. Good for visualization, FK/IK and motion planning; **not** usable for dynamics
or torque control without real inertia tensors.

Joint `effort` is the source `actuatorfrcrange` (100 N·m arm, 5 N gripper). `velocity` is a
placeholder 100 rad/s, not a real limit - do not use it for trajectory time scaling.

The source also carries per-joint `damping` and position-servo gains (`kp`, `kv`) which have no
URDF equivalent and were dropped; see `piper_x_left_arm.xml` if you need them.
