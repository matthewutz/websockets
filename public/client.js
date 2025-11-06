// Initialize Socket.IO
const socket = io();
let currentSessionId = 'default-session';
let isConnected = false;
let userCount = 1;

// Three.js setup
let scene, camera, renderer, clayMesh, raycaster, mouse;
let isSculpting = false;
let isRotating = false;
let currentVertexIndex = null;
const sculptRadius = 0.1;
const sculptStrength = 0.05;

// Tool selection
let currentTool = 'add'; // 'add', 'subtract', 'smooth'

// Camera rotation
let cameraAngleX = 0;
let cameraAngleY = 0;
let lastMouseX = 0;
let lastMouseY = 0;
let cameraDistance = 5;

// Initialize Three.js scene
function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);
    
    camera = new THREE.PerspectiveCamera(
        75,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
    );
    camera.position.set(0, 0, 5);
    
    renderer = new THREE.WebGLRenderer({ 
        canvas: document.getElementById('canvas'),
        antialias: true 
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    // Enable proper face culling
    renderer.setClearColor(0x1a1a1a, 1);
    
    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 5, 5);
    scene.add(directionalLight);
    
    const pointLight = new THREE.PointLight(0xffffff, 0.5);
    pointLight.position.set(-5, -5, -5);
    scene.add(pointLight);
    
    // Raycaster for mouse interaction
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();
    
    // Create default clay (will be replaced by server state)
    createDefaultClay();
    
    // Update camera position based on angles
    updateCameraPosition();
    
    // Event listeners
    window.addEventListener('resize', onWindowResize);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('wheel', onMouseWheel, { passive: false });
    
    // Prevent context menu on right click (for better UX)
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    
    animate();
}

// Create default clay mesh
function createDefaultClay() {
    const geometry = new THREE.BufferGeometry();
    const radius = 1;
    const segments = 32;
    
    const vertices = [];
    const indices = [];
    const normals = [];
    
    // Generate sphere vertices
    for (let i = 0; i <= segments; i++) {
        const theta = (i * Math.PI) / segments;
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);
        
        for (let j = 0; j <= segments; j++) {
            const phi = (j * 2 * Math.PI) / segments;
            const sinPhi = Math.sin(phi);
            const cosPhi = Math.cos(phi);
            
            const x = radius * sinTheta * cosPhi;
            const y = radius * cosTheta;
            const z = radius * sinTheta * sinPhi;
            
            vertices.push(x, y, z);
            normals.push(sinTheta * cosPhi, cosTheta, sinTheta * sinPhi);
        }
    }
    
    // Generate indices (ensuring correct winding order for front-facing)
    for (let i = 0; i < segments; i++) {
        for (let j = 0; j < segments; j++) {
            const a = i * (segments + 1) + j;
            const b = a + segments + 1;
            
            // First triangle - ensure counter-clockwise winding
            indices.push(a, a + 1, b);
            // Second triangle
            indices.push(a + 1, b + 1, b);
        }
    }
    
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    
    const material = new THREE.MeshStandardMaterial({
        color: 0x808080, // Grey color
        roughness: 0.7,
        metalness: 0.1,
        side: THREE.FrontSide, // Only render front faces
        flatShading: false
    });
    
    if (clayMesh) {
        scene.remove(clayMesh);
        clayMesh.geometry.dispose();
        clayMesh.material.dispose();
    }
    
    clayMesh = new THREE.Mesh(geometry, material);
    // Enable proper face culling
    clayMesh.material.needsUpdate = true;
    scene.add(clayMesh);
}

// Update clay mesh from server state
function updateClayFromState(clayState) {
    if (!clayState || !clayState.vertices) return;
    
    const geometry = new THREE.BufferGeometry();
    const vertices = [];
    const indices = clayState.indices || [];
    
    // Convert vertices array to flat array
    for (const vertex of clayState.vertices) {
        vertices.push(vertex.x, vertex.y, vertex.z);
    }
    
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    if (indices.length > 0) {
        geometry.setIndex(indices);
    }
    geometry.computeVertexNormals();
    
    if (!clayMesh) {
        const material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(
                clayState.color?.r || 0.5,
                clayState.color?.g || 0.5,
                clayState.color?.b || 0.5
            ),
            roughness: 0.7,
            metalness: 0.1,
            side: THREE.FrontSide, // Only render front faces
            flatShading: false
        });
        clayMesh = new THREE.Mesh(geometry, material);
        scene.add(clayMesh);
    } else {
        clayMesh.geometry.dispose();
        clayMesh.geometry = geometry;
    }
}

// Sculpt the clay at a point
function sculptAtPoint(point, direction, strength) {
    if (!clayMesh) return;
    
    const positionAttribute = clayMesh.geometry.attributes.position;
    const positions = positionAttribute.array;
    const vertices = [];
    
    // Convert flat array to vertex objects
    for (let i = 0; i < positions.length; i += 3) {
        vertices.push({
            index: i / 3,
            x: positions[i],
            y: positions[i + 1],
            z: positions[i + 2]
        });
    }
    
    // Find vertices within sculpt radius
    const affectedVertices = [];
    for (const vertex of vertices) {
        const vertexPos = new THREE.Vector3(vertex.x, vertex.y, vertex.z);
        const distance = vertexPos.distanceTo(point);
        
        if (distance < sculptRadius) {
            const influence = 1 - (distance / sculptRadius);
            affectedVertices.push({
                index: vertex.index,
                vertex: vertex,
                influence: influence,
                distance: distance
            });
        }
    }
    
    // Handle different tools
    if (currentTool === 'smooth') {
        smoothVertices(affectedVertices, vertices);
    } else {
        // Add or Subtract
        // Direction should now point outward (away from center)
        // Add pushes outward (along normal), Subtract pulls inward (opposite normal)
        const toolStrength = currentTool === 'add' ? strength : -strength;
        
        for (const affected of affectedVertices) {
            const pushStrength = toolStrength * affected.influence;
            // Move along the normal direction
            const newX = affected.vertex.x + direction.x * pushStrength;
            const newY = affected.vertex.y + direction.y * pushStrength;
            const newZ = affected.vertex.z + direction.z * pushStrength;
            
            // Update position array
            const idx = affected.index * 3;
            positions[idx] = newX;
            positions[idx + 1] = newY;
            positions[idx + 2] = newZ;
            
            // Emit change to server
            socket.emit('sculpt-change', {
                sessionId: currentSessionId,
                vertexIndex: affected.index,
                position: { x: newX, y: newY, z: newZ }
            });
        }
    }
    
    positionAttribute.needsUpdate = true;
    clayMesh.geometry.computeVertexNormals();
}

// Smooth tool - averages nearby vertices using Laplacian smoothing
function smoothVertices(affectedVertices, allVertices) {
    if (!clayMesh) return;
    
    const positionAttribute = clayMesh.geometry.attributes.position;
    const positions = positionAttribute.array;
    const smoothRadius = sculptRadius * 2.0; // Larger radius for better smoothing
    const updates = [];
    
    for (const affected of affectedVertices) {
        const vertexPos = new THREE.Vector3(affected.vertex.x, affected.vertex.y, affected.vertex.z);
        let sumX = 0, sumY = 0, sumZ = 0;
        let count = 0;
        let totalWeight = 0;
        
        // Find all nearby vertices for averaging (including the vertex itself for stability)
        for (const vertex of allVertices) {
            const otherPos = new THREE.Vector3(vertex.x, vertex.y, vertex.z);
            const distance = vertexPos.distanceTo(otherPos);
            
            if (distance < smoothRadius) {
                // Weight closer vertices more, but include self with full weight
                const weight = distance === 0 ? 1.0 : (1 - (distance / smoothRadius)) * (1 - (distance / smoothRadius));
                sumX += vertex.x * weight;
                sumY += vertex.y * weight;
                sumZ += vertex.z * weight;
                totalWeight += weight;
                count++;
            }
        }
        
        if (count > 1 && totalWeight > 0) { // Need at least 2 vertices (self + neighbor)
            // Compute weighted average
            const avgX = sumX / totalWeight;
            const avgY = sumY / totalWeight;
            const avgZ = sumZ / totalWeight;
            
            // Blend factor: stronger smoothing (0.5 to 1.0 based on influence)
            // This makes the smoothing much more noticeable
            const blendFactor = Math.min(1.0, 0.5 + affected.influence * 0.5);
            
            const newX = affected.vertex.x * (1 - blendFactor) + avgX * blendFactor;
            const newY = affected.vertex.y * (1 - blendFactor) + avgY * blendFactor;
            const newZ = affected.vertex.z * (1 - blendFactor) + avgZ * blendFactor;
            
            // Update position array
            const idx = affected.index * 3;
            positions[idx] = newX;
            positions[idx + 1] = newY;
            positions[idx + 2] = newZ;
            
            updates.push({
                vertexIndex: affected.index,
                position: { x: newX, y: newY, z: newZ }
            });
        }
    }
    
    // Emit all updates for smooth tool (batch update)
    if (updates.length > 0) {
        socket.emit('sculpt-batch', {
            sessionId: currentSessionId,
            updates: updates
        });
    }
}

// Update camera position based on rotation angles
function updateCameraPosition() {
    const x = Math.sin(cameraAngleY) * Math.cos(cameraAngleX) * cameraDistance;
    const y = Math.sin(cameraAngleX) * cameraDistance;
    const z = Math.cos(cameraAngleY) * Math.cos(cameraAngleX) * cameraDistance;
    
    camera.position.set(x, y, z);
    camera.lookAt(0, 0, 0);
}

// Mouse event handlers
function onMouseMove(event) {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    
    // Handle camera rotation (right mouse button or middle mouse button)
    if ((event.buttons === 2 || event.buttons === 4) && !isSculpting) {
        const deltaX = event.clientX - lastMouseX;
        const deltaY = event.clientY - lastMouseY;
        
        cameraAngleY -= deltaX * 0.01;
        cameraAngleX -= deltaY * 0.01;
        
        // Limit vertical rotation
        cameraAngleX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, cameraAngleX));
        
        updateCameraPosition();
        isRotating = true;
    } else if (isSculpting && clayMesh) {
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObject(clayMesh);
        
        if (intersects.length > 0) {
            const intersect = intersects[0];
            // Use radial direction (from center to intersection point) for more reliable sculpting
            // This ensures we always push/pull relative to the sphere center
            const center = new THREE.Vector3(0, 0, 0);
            const radialDirection = intersect.point.clone().sub(center).normalize();
            
            // Use the selected tool (add/subtract/smooth)
            sculptAtPoint(intersect.point, radialDirection, sculptStrength);
        }
    }
    
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
}

function onMouseWheel(event) {
    event.preventDefault();
    const zoomSpeed = 0.5;
    const newDistance = cameraDistance + (event.deltaY > 0 ? zoomSpeed : -zoomSpeed);
    
    if (newDistance >= 2 && newDistance <= 10) {
        cameraDistance = newDistance;
        updateCameraPosition();
    }
}

function onMouseDown(event) {
    if (!isConnected) return;
    
    // Right mouse button or middle mouse button for rotation
    if (event.button === 2 || event.button === 1) {
        isRotating = true;
        lastMouseX = event.clientX;
        lastMouseY = event.clientY;
        document.body.style.cursor = 'grabbing';
        return;
    }
    
    // Left mouse button for sculpting
    if (event.button !== 0) return;
    
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(clayMesh);
    
    if (intersects.length > 0) {
        isSculpting = true;
        document.body.style.cursor = 'grabbing';
    }
}

function onMouseUp(event) {
    isSculpting = false;
    isRotating = false;
    document.body.style.cursor = 'default';
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Animation loop
function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
}

// Socket.IO event handlers
socket.on('connect', () => {
    console.log('Connected to server');
    isConnected = true;
    joinSession();
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
    isConnected = false;
});

socket.on('clay-state', (clayState) => {
    console.log('Received clay state from server');
    updateClayFromState(clayState);
});

socket.on('vertex-update', (data) => {
    if (!clayMesh) return;
    
    const { vertexIndex, position } = data;
    const positionAttribute = clayMesh.geometry.attributes.position;
    const positions = positionAttribute.array;
    
    if (vertexIndex * 3 < positions.length) {
        positions[vertexIndex * 3] = position.x;
        positions[vertexIndex * 3 + 1] = position.y;
        positions[vertexIndex * 3 + 2] = position.z;
        
        positionAttribute.needsUpdate = true;
        clayMesh.geometry.computeVertexNormals();
    }
});

socket.on('vertex-batch-update', (data) => {
    if (!clayMesh || !data.updates) return;
    
    const positionAttribute = clayMesh.geometry.attributes.position;
    const positions = positionAttribute.array;
    
    for (const update of data.updates) {
        const { vertexIndex, position } = update;
        if (vertexIndex * 3 < positions.length && position) {
            positions[vertexIndex * 3] = position.x;
            positions[vertexIndex * 3 + 1] = position.y;
            positions[vertexIndex * 3 + 2] = position.z;
        }
    }
    
    positionAttribute.needsUpdate = true;
    clayMesh.geometry.computeVertexNormals();
});

socket.on('user-joined', (userId) => {
    console.log('User joined:', userId);
    userCount++;
    updateUserCount();
});

// UI event handlers
document.getElementById('join-btn').addEventListener('click', () => {
    const sessionId = document.getElementById('session-id').value.trim();
    if (sessionId) {
        currentSessionId = sessionId;
        joinSession();
    }
});

document.getElementById('reset-btn').addEventListener('click', async () => {
    if (confirm('Reset the clay to default shape?')) {
        try {
            const response = await fetch(`/api/session/${currentSessionId}/reset`, {
                method: 'POST'
            });
            if (response.ok) {
                console.log('Clay reset - waiting for server state update');
                // The server will emit 'clay-state' which will trigger updateClayFromState
            } else {
                console.error('Failed to reset clay');
                alert('Failed to reset clay. Please try again.');
            }
        } catch (error) {
            console.error('Error resetting clay:', error);
            alert('Error resetting clay: ' + error.message);
        }
    }
});

// Tool selection handlers
document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        // Remove active class from all buttons
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        // Add active class to clicked button
        btn.classList.add('active');
        // Update current tool
        currentTool = btn.getAttribute('data-tool');
        console.log('Tool changed to:', currentTool);
    });
});

function joinSession() {
    if (isConnected) {
        socket.emit('join-session', currentSessionId);
    }
}

function updateUserCount() {
    document.getElementById('count').textContent = userCount;
}

// Initialize on load
window.addEventListener('load', () => {
    initScene();
});

