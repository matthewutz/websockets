// Initialize Socket.IO
const socket = io();
let currentSessionId = 'default-session';
let isConnected = false;
let userCount = 1;

// Three.js setup
let scene, camera, renderer, clayMesh, raycaster, mouse, toolIndicator;
let isSculpting = false;
let isRotating = false;
let currentVertexIndex = null;
const sculptRadius = 0.1;
const sculptStrength = 0.2; // Increased strength for more noticeable sculpting

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
    
    // Lighting - enhanced for better visibility of modified vertices
    // Higher ambient light reduces harsh shadows on deformed surfaces
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambientLight);
    
    // Hemisphere light for more natural, even lighting
    const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    scene.add(hemisphereLight);
    
    // Main directional light
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
    directionalLight.position.set(5, 5, 5);
    directionalLight.castShadow = false;
    scene.add(directionalLight);
    
    // Additional directional light from opposite side to reduce dark areas
    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
    directionalLight2.position.set(-5, 3, -5);
    directionalLight2.castShadow = false;
    scene.add(directionalLight2);
    
    // Raycaster for mouse interaction
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();
    
    // Create tool indicator (sphere showing area of effect)
    createToolIndicator();
    
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
    const segments = 64; // Increased for higher polygon count
    
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
    geometry.setIndex(indices);
    // Compute vertex normals (will overwrite the manually set normals)
    geometry.computeVertexNormals();
    geometry.normalizeNormals();
    
    const material = new THREE.MeshStandardMaterial({
        color: 0x808080, // Grey color
        roughness: 0.7,
        metalness: 0.1,
        side: THREE.FrontSide, // Only render front faces
        flatShading: false,
        transparent: false, // Ensure no transparency
        opacity: 1.0,
        depthWrite: true,
        depthTest: true,
        // Add slight emissive component to prevent pure black shadows
        emissive: 0x1a1a1a,
        emissiveIntensity: 0.1,
        // Fix z-fighting with overlapping geometry
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
    });
    
    if (clayMesh) {
        scene.remove(clayMesh);
        clayMesh.geometry.dispose();
        clayMesh.material.dispose();
    }
    
    clayMesh = new THREE.Mesh(geometry, material);
    // Enable proper face culling
    clayMesh.material.needsUpdate = true;
    // Set render order to prevent z-fighting with tool indicator
    clayMesh.renderOrder = 0;
    scene.add(clayMesh);
    // Ensure normals point outward after creating mesh
    ensureOutwardNormals();
}

// Create visual indicator for tool area of effect
function createToolIndicator() {
    const indicatorGeometry = new THREE.SphereGeometry(sculptRadius, 16, 16);
    const indicatorMaterial = new THREE.MeshBasicMaterial({
        color: 0x4a9eff,
        wireframe: true,
        transparent: true,
        opacity: 0.6,
        depthTest: false, // Always visible
        side: THREE.DoubleSide
    });
    toolIndicator = new THREE.Mesh(indicatorGeometry, indicatorMaterial);
    toolIndicator.visible = false;
    toolIndicator.renderOrder = 1; // Render on top
    scene.add(toolIndicator);
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
    // Compute vertex normals and ensure they're normalized
    geometry.computeVertexNormals();
    geometry.normalizeNormals();
    
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
            flatShading: false,
            transparent: false, // Ensure no transparency
            opacity: 1.0,
            depthWrite: true,
            depthTest: true,
            // Add slight emissive component to prevent pure black shadows
            emissive: 0x1a1a1a,
            emissiveIntensity: 0.1,
            // Fix z-fighting with overlapping geometry
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
        });
        clayMesh = new THREE.Mesh(geometry, material);
        scene.add(clayMesh);
        // Ensure normals point outward after creating mesh
        ensureOutwardNormals();
    } else {
        const oldMaterial = clayMesh.material;
        clayMesh.geometry.dispose();
        clayMesh.geometry = geometry;
        // Preserve material properties including polygonOffset
        if (oldMaterial) {
            oldMaterial.polygonOffset = true;
            oldMaterial.polygonOffsetFactor = 1;
            oldMaterial.polygonOffsetUnits = 1;
        }
        // Ensure normals point outward after updating geometry
        ensureOutwardNormals();
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
    // Recompute normals with proper settings for deformed geometry
    clayMesh.geometry.computeVertexNormals();
    // Ensure normals point outward from center (fixes lighting issues with overlapping geometry)
    ensureOutwardNormals();
    // Ensure normal attribute is marked for update
    if (clayMesh.geometry.attributes.normal) {
        clayMesh.geometry.attributes.normal.needsUpdate = true;
    }
    // Force geometry update
    clayMesh.geometry.computeBoundingSphere();
}

// Ensure normals point outward from center to fix lighting issues
function ensureOutwardNormals() {
    if (!clayMesh || !clayMesh.geometry.attributes.normal) return;
    
    const positionAttribute = clayMesh.geometry.attributes.position;
    const normalAttribute = clayMesh.geometry.attributes.normal;
    const positions = positionAttribute.array;
    const normals = normalAttribute.array;
    const center = new THREE.Vector3(0, 0, 0);
    
    // For each vertex, ensure normal points outward from center
    for (let i = 0; i < positions.length; i += 3) {
        const vertexPos = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
        const currentNormal = new THREE.Vector3(normals[i], normals[i + 1], normals[i + 2]);
        
        // Calculate radial direction (from center to vertex)
        const radialDir = vertexPos.clone().sub(center).normalize();
        
        // Check if current normal points in similar direction to radial
        const dot = currentNormal.dot(radialDir);
        
        // If normal points inward (dot < 0), flip it or use radial direction
        if (dot < 0) {
            // Use radial direction as normal (ensures outward pointing)
            normals[i] = radialDir.x;
            normals[i + 1] = radialDir.y;
            normals[i + 2] = radialDir.z;
        } else {
            // Blend between computed normal and radial to ensure it points outward
            // This preserves surface detail while ensuring correct direction
            const blended = currentNormal.clone().lerp(radialDir, 0.3).normalize();
            normals[i] = blended.x;
            normals[i + 1] = blended.y;
            normals[i + 2] = blended.z;
        }
    }
    
    normalAttribute.needsUpdate = true;
}

// Smooth tool - brings nearby vertices closer together using Laplacian smoothing
function smoothVertices(affectedVertices, allVertices) {
    if (!clayMesh) return;
    
    const positionAttribute = clayMesh.geometry.attributes.position;
    const positions = positionAttribute.array;
    const smoothRadius = sculptRadius * 2.5; // Larger radius for better smoothing
    const updates = [];
    
    for (const affected of affectedVertices) {
        const vertexPos = new THREE.Vector3(affected.vertex.x, affected.vertex.y, affected.vertex.z);
        let sumX = 0, sumY = 0, sumZ = 0;
        let count = 0;
        let totalWeight = 0;
        
        // Find all nearby vertices for averaging (EXCLUDE the vertex itself)
        for (const vertex of allVertices) {
            // Skip the vertex itself - we want to move toward neighbors
            if (vertex.index === affected.index) continue;
            
            const otherPos = new THREE.Vector3(vertex.x, vertex.y, vertex.z);
            const distance = vertexPos.distanceTo(otherPos);
            
            if (distance < smoothRadius && distance > 0) {
                // Weight closer neighbors more heavily
                // Use inverse distance squared for better smoothing
                const weight = (1 - (distance / smoothRadius)) * (1 - (distance / smoothRadius));
                sumX += vertex.x * weight;
                sumY += vertex.y * weight;
                sumZ += vertex.z * weight;
                totalWeight += weight;
                count++;
            }
        }
        
        if (count > 0 && totalWeight > 0) {
            // Compute weighted average of neighboring vertices
            const avgX = sumX / totalWeight;
            const avgY = sumY / totalWeight;
            const avgZ = sumZ / totalWeight;
            
            // Smoothing strength: move vertex toward average of neighbors
            // Higher influence = more smoothing
            const smoothStrength = 0.4 + (affected.influence * 0.4); // 0.4 to 0.8
            
            // Move vertex toward the average position of neighbors
            // This brings vertices closer together, reducing surface variation
            const newX = affected.vertex.x * (1 - smoothStrength) + avgX * smoothStrength;
            const newY = affected.vertex.y * (1 - smoothStrength) + avgY * smoothStrength;
            const newZ = affected.vertex.z * (1 - smoothStrength) + avgZ * smoothStrength;
            
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
    
    // Update geometry after smoothing
    positionAttribute.needsUpdate = true;
    if (updates.length > 0) {
        // Recompute normals with proper settings
        clayMesh.geometry.computeVertexNormals();
        // Ensure normals point outward from center
        ensureOutwardNormals();
        if (clayMesh.geometry.attributes.normal) {
            clayMesh.geometry.attributes.normal.needsUpdate = true;
        }
        clayMesh.geometry.computeBoundingSphere();
        
        // Emit all updates for smooth tool (batch update)
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
    } else if (clayMesh) {
        // Always update tool indicator position
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObject(clayMesh);
        
        if (intersects.length > 0) {
            const intersect = intersects[0];
            
            // Update tool indicator position and visibility
            if (toolIndicator) {
                toolIndicator.position.copy(intersect.point);
                toolIndicator.visible = true;
            }
            
            if (isSculpting) {
                // Use radial direction (from center to intersection point) for more reliable sculpting
                // This ensures we always push/pull relative to the sphere center
                const center = new THREE.Vector3(0, 0, 0);
                const radialDirection = intersect.point.clone().sub(center).normalize();
                
                // Use the selected tool (add/subtract/smooth)
                sculptAtPoint(intersect.point, radialDirection, sculptStrength);
            }
        } else if (toolIndicator) {
            toolIndicator.visible = false;
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
    // Tool indicator visibility is handled in onMouseMove
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
        // Recompute normals properly
        clayMesh.geometry.computeVertexNormals();
        // Ensure normals point outward from center
        ensureOutwardNormals();
        if (clayMesh.geometry.attributes.normal) {
            clayMesh.geometry.attributes.normal.needsUpdate = true;
        }
        clayMesh.geometry.computeBoundingSphere();
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
    // Recompute normals properly
    clayMesh.geometry.computeVertexNormals();
    // Ensure normals point outward from center
    ensureOutwardNormals();
    if (clayMesh.geometry.attributes.normal) {
        clayMesh.geometry.attributes.normal.needsUpdate = true;
    }
    clayMesh.geometry.computeBoundingSphere();
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

