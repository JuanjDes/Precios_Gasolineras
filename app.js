// Suprimir warnings de deprecación de Leaflet (son inofensivos)
const originalWarn = console.warn;
console.warn = function(...args) {
    // Filtrar warnings específicos de Leaflet sobre MouseEvent obsoleto
    const message = args.join(' ');
    if (message.includes('MouseEvent.mozPressure está obsoleto') || 
        message.includes('MouseEvent.mozInputSource está obsoleto') ||
        message.includes('Util.js')) {
        return; // No mostrar estos warnings
    }
    originalWarn.apply(console, args);
};

// Variables globales
const cityInput = document.getElementById('city-input');
const searchBtn = document.getElementById('search-btn');
const resultsContainer = document.getElementById('results-container');
const loadingSpinner = document.getElementById('loading-spinner');
const errorMessage = document.getElementById('error-message');
const cityButtons = document.querySelectorAll('.city-btn');
const sortOptions = document.getElementById('sort-options');
const sortButtons = document.querySelectorAll('.sort-btn');
const fuelSelect = document.getElementById('fuel-select');
const useLocationBtn = document.getElementById('use-location-btn');
const locationStatus = document.getElementById('location-status');
const mapContainer = document.getElementById('map');
const prevPageBtn = document.getElementById('prev-page');
const nextPageBtn = document.getElementById('next-page');
const pageInfo = document.getElementById('page-info');

// Variables para paginación
let currentStations = [];
let displayedStations = [];
let currentPage = 1;
const pageSize = 10;
let totalPages = 1;
let userLocation = null;
let cityCenter = null;
let usingMockData = false; // Bandera para saber si está usando datos mock

// Caché API por 10 minutos
const CACHE_KEY = 'gasolineras-precios-cache';
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

// Caché para resultados por ciudad (5 minutos)
const CITY_CACHE_KEY_PREFIX = 'gasolineras-ciudad-';
const CITY_CACHE_TTL = 5 * 60 * 1000; // 5 minutos


// Leaflet map.
let map = null;
let markersLayer = null;

// Event Listeners
searchBtn.addEventListener('click', handleSearch);
cityInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        handleSearch();
    }
});

cityButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        cityInput.value = btn.dataset.city;
        handleSearch();
    });
});

fuelSelect.addEventListener('change', () => {
    if (currentStations.length > 0) {
        sortAndDisplay(getActiveSortType());
    }
});

useLocationBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
        setLocationStatus('Geolocalización no disponible en este navegador', 'error');
        return;
    }

    setLocationStatus('Obteniendo ubicación…');
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            userLocation = {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude
            };
            setLocationStatus(`Ubicación activa: ${userLocation.lat.toFixed(5)}, ${userLocation.lng.toFixed(5)}`, 'activado');
            if (currentStations.length > 0) {
                updateDistanceForStations();
                sortAndDisplay(getActiveSortType());
            }
        },
        (err) => {
            setLocationStatus(`Error geolocalización: ${err.message}`, 'error');
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
});

sortButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        // Remover clase active de todos los botones
        sortButtons.forEach(b => b.classList.remove('active'));
        // Agregar clase active al botón clickeado
        btn.classList.add('active');
        // Ordenar y mostrar resultados
        const sortType = btn.dataset.sort;
        sortAndDisplay(sortType);
    });
});

prevPageBtn.addEventListener('click', () => {
    if (currentPage > 1) {
        currentPage -= 1;
        renderPage();
    }
});

nextPageBtn.addEventListener('click', () => {
    if (currentPage < totalPages) {
        currentPage += 1;
        renderPage();
    }
});

// Inicializa mapa Leaflet para su uso inmediato.
function initMap() {
    console.log('Iniciando mapa...');
    if (!mapContainer) {
        console.warn('mapContainer element no encontrado (#map)');
        return;
    }

    if (map) {
        console.log('Mapa ya inicializado, omitiendo...');
        return;
    }

    if (typeof L === 'undefined') {
        console.warn('Leaflet library no disponible');
        return;
    }

    try {
        map = L.map('map').setView([40.4168, -3.7038], 6);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);

        markersLayer = L.layerGroup().addTo(map);
        console.log('Mapa inicializado correctamente');
    } catch (error) {
        console.error('Error al inicializar el mapa:', error);
    }
}

/**
 * Función principal para manejar la búsqueda
 */
async function handleSearch() {
    const city = cityInput.value.trim();

    if (!city) {
        showError('Por favor, introduce el nombre de una ciudad');
        return;
    }

    if (!fuelSelect) {
        console.error('fuelSelect element no encontrado');
        showError('Error: elemento de combustible no disponible');
        return;
    }

    showLoading(true);
    clearError();
    resultsContainer.innerHTML = '';
    
    // Hide map during search (renderPage will show it if results exist)
    const mapElement = document.getElementById('map');
    if (mapElement) mapElement.classList.add('hidden');

    try {
        // Geocodificar ciudad para ubicaciones y distancias aproximadas
        console.log('Geocodificando ciudad:', city);
        cityCenter = await geocodeCity(city);
        console.log('Resultado geocodificación:', cityCenter);

        // Llamar a la API para obtener gasolineras
        console.log('Obteniendo estaciones para:', city);
        const stationsResult = await fetchGasStations(city);
        const stations = stationsResult.stations || [];
        usingMockData = stationsResult.isMock || false;
        
        if (usingMockData) {
            console.warn('⚠️ Usando DATOS DE DEMOSTRACIÓN (la API podría no estar disponible)');
        } else {
            console.log('✅ Usando datos REALES de la API');
        }
        console.log('Estaciones obtenidas:', stations.length);
        
        const selectedFuel = fuelSelect.value;
        console.log('Combustible seleccionado:', selectedFuel);

        if (stations.length === 0) {
            showError(`No se encontraron gasolineras en ${city}`);
            showLoading(false);
            return;
        }

        console.log('Aplicando filtro de combustible:', selectedFuel);
        currentStations = applyFuelFilter(stations, selectedFuel);
        console.log('Estaciones filtradas:', currentStations.length);

        if (currentStations.length === 0) {
            showError(`No se encontraron gasolineras con combustible ${selectedFuel} en ${city}`);
            showLoading(false);
            return;
        }

        if (userLocation) {
            console.log('Actualizando distancia desde ubicación del usuario');
            updateDistanceForStations(userLocation);
        } else if (cityCenter) {
            console.log('Actualizando distancia desde centro de la ciudad');
            updateDistanceForStations(cityCenter);
        }

        sortOptions.classList.remove('hidden');
        if (cityCenter && map) {
            console.log('Centrado el mapa en:', cityCenter);
            map.setView([cityCenter.lat, cityCenter.lng], 12);
        }
        currentPage = 1; // Reset a página 1
        renderPage();
        showLoading(false);
        console.log('Búsqueda completada exitosamente');
    } catch (error) {
        console.error('Error en handleSearch:', error);
        console.error('Stack trace:', error.stack);
        showError(`Error al buscar gasolineras: ${error.message}`);
        showLoading(false);
    }
}

/**
 * Simulación de fetch de gasolineras
 * Esta función será reemplazada con una llamada real a una API
 */
async function fetchGasStations(city) {
    const normalizedCity = city.trim().toLowerCase();

    // API pública del Ministerio de Industria (CNMC)
    const apiUrl = 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres';

    try {
        // Primero verificar caché por ciudad
        console.log('Verificando caché para ciudad:', normalizedCity);
        const cityCached = getCityCache(normalizedCity);
        if (cityCached) {
            console.log('Usando datos del caché de ciudad:', cityCached.length, 'estaciones');
            return { stations: cityCached, isMock: false };
        }

        console.log('Haciendo llamada a la API:', apiUrl);
        const response = await fetch(apiUrl);

        if (!response.ok) {
            throw new Error(`Error HTTP ${response.status}`);
        }

        const data = await response.json();
        const stationsRaw = data.ListaEESSPrecio || [];
        console.log('API respondió con:', stationsRaw.length, 'estaciones totales');

        // Filtrar por municipio/localidad (búsqueda por ciudad)
        console.log('Filtrando por ciudad:', normalizedCity);
        let filtered = stationsRaw.filter(item => {
            const municipio = (item.Municipio || '').toString().trim().toLowerCase();
            const localidad = (item.Localidad || '').toString().trim().toLowerCase();
            const provincia = (item.Provincia || '').toString().trim().toLowerCase();
            
            // Búsqueda más precisa: NO buscar en direcciones para evitar gasolineras en carreteras
            // Solo buscar en municipio, localidad y provincia
            return municipio.includes(normalizedCity) || 
                   localidad.includes(normalizedCity) || 
                   provincia.includes(normalizedCity);
        });

        console.log('Estaciones encontradas para', normalizedCity + ':', filtered.length);
        
        // Debug: mostrar algunos ejemplos de lo que encontró
        if (filtered.length > 0) {
            console.log('Ejemplos de municipios encontrados:', 
                filtered.slice(0, 3).map(item => item.Municipio || item.Localidad).join(', '));
        }
        
        if (filtered.length === 0) {
            console.warn('Sin resultados exactos, intentando búsqueda más amplia...');
            // Búsqueda alternativa: si normalizedCity es corto, buscar por provincia
            if (normalizedCity.length > 2) {
                const broadSearch = stationsRaw.filter(item => {
                    const provincia = (item.Provincia || '').toString().trim().toLowerCase();
                    return provincia.includes(normalizedCity.substring(0, 3));
                });
                console.log('Búsqueda amplia encontró:', broadSearch.length, 'estaciones');
                if (broadSearch.length > 0) {
                    filtered.push(...broadSearch.slice(0, 50));
                }
            }
        }

        // Mapping a esquema interno
        const mapped = filtered.slice(0, 120).map((item, idx) => ({
            id: idx + 1,
            name: item.Rótulo || item.Dirección || 'Gasolinera',
            city: item.Municipio || item.Localidad || city,
            address: item.Dirección || 'Dirección no disponible',
            latitude: parseFloat((item.Latitud || '0').replace(',', '.')) || 0,
            longitude: parseFloat((item['Longitud (WGS84)'] || '0').replace(',', '.')) || 0,
            gasolina95: parseFloat((item['Precio Gasolina 95 E5'] || item['Precio Gasolina 95 E10'] || item['Precio Gasolina 95 E25'] || '0').replace(',', '.')) || 0,
            gasolina98: parseFloat((item['Precio Gasolina 98 E5'] || item['Precio Gasolina 98 E10'] || '0').replace(',', '.')) || 0,
            gasoleo: parseFloat((item['Precio Gasoleo A'] || item['Precio Gasoleo B'] || '0').replace(',', '.')) || 0,
            distance: 0
        }));

        // Si no hay resultados, devolver arreglo vacío
        if (mapped.length === 0) {
            console.warn('No hay estaciones mapeadas');
            return { stations: [], isMock: false };
        }

        console.log('Estaciones mapeadas:', mapped.length);
        
        // Guardar en caché por ciudad
        setCityCache(normalizedCity, mapped);
        
        return { stations: mapped, isMock: false };

    } catch (error) {
        console.error('Error en fetchGasStations:', error);
        console.log('Usando datos mock como fallback');
        // Si la API falla (CORS / fuera de servicio), devolvemos datos mock para continuidad
        return {
            stations: getMockStations(city),
            isMock: true
        };
    }
}

function getMockStations(city) {
    console.warn('⚠️ Usando datos MOCK (15 estaciones de demostración)');
    const mockData = [
        { id: 1, name: 'Gasolinera Repsol Premium', city, address: 'Calle Principal, 123', latitude: 40.4168, longitude: -3.7038, gasolina95: 1.549, gasoleo: 1.429, gasolina98: 1.659, distance: 2.3 },
        { id: 2, name: 'Gasolinera Cepsa Express', city, address: 'Avenida de la Paz, 456', latitude: 40.42, longitude: -3.7, gasolina95: 1.539, gasoleo: 1.419, gasolina98: 1.649, distance: 3.1 },
        { id: 3, name: 'BP Gasolinera', city, address: 'Plaza Mayor, 789', latitude: 40.415, longitude: -3.705, gasolina95: 1.559, gasoleo: 1.439, gasolina98: 1.669, distance: 1.8 },
        { id: 4, name: 'Gasolinera Alcampo', city, address: 'Centro Comercial, 321', latitude: 40.418, longitude: -3.702, gasolina95: 1.519, gasoleo: 1.399, gasolina98: 1.629, distance: 4.5 },
        { id: 5, name: 'Shell Gasolinera Centro', city, address: 'Paseo de la Castellana, 234', latitude: 40.425, longitude: -3.695, gasolina95: 1.555, gasoleo: 1.435, gasolina98: 1.665, distance: 2.1 },
        { id: 6, name: 'OMV Gasolinera', city, address: 'Carrera 5, 567', latitude: 40.41, longitude: -3.71, gasolina95: 1.535, gasoleo: 1.415, gasolina98: 1.645, distance: 3.7 },
        { id: 7, name: 'Gasolinera Galp', city, address: 'Avenida Diagonal, 890', latitude: 40.405, longitude: -3.693, gasolina95: 1.565, gasoleo: 1.445, gasolina98: 1.675, distance: 1.5 },
        { id: 8, name: 'Repsol Express 24h', city, address: 'Calle Mayor, 111', latitude: 40.422, longitude: -3.708, gasolina95: 1.559, gasoleo: 1.439, gasolina98: 1.669, distance: 2.8 },
        { id: 9, name: 'Gasolinera Campsa', city, address: 'Plaza de la República, 222', latitude: 40.408, longitude: -3.698, gasolina95: 1.529, gasoleo: 1.409, gasolina98: 1.639, distance: 3.4 },
        { id: 10, name: 'Carrefour Gasolinera', city, address: 'Polígono Industrial, 333', latitude: 40.395, longitude: -3.715, gasolina95: 1.545, gasoleo: 1.425, gasolina98: 1.655, distance: 5.2 },
        { id: 11, name: 'Gasolinera Eco', city, address: 'Montaña, 444', latitude: 40.43, longitude: -3.685, gasolina95: 1.525, gasoleo: 1.405, gasolina98: 1.635, distance: 1.2 },
        { id: 12, name: 'Peugeot Gasolinera', city, address: 'Zona Norte, 555', latitude: 40.44, longitude: -3.68, gasolina95: 1.555, gasoleo: 1.435, gasolina98: 1.665, distance: 4.1 },
        { id: 13, name: 'Gasolinera El Corte', city, address: 'Puerto, 666', latitude: 40.41, longitude: -3.72, gasolina95: 1.535, gasoleo: 1.415, gasolina98: 1.645, distance: 3.9 },
        { id: 14, name: 'Leclerc Gasolinera', city, address: 'Carretera, 777', latitude: 40.403, longitude: -3.705, gasolina95: 1.549, gasoleo: 1.429, gasolina98: 1.659, distance: 2.6 },
        { id: 15, name: 'Gasolinera Premium Select', city, address: 'Avenida 9 de Julio, 888', latitude: 40.415, longitude: -3.69, gasolina95: 1.567, gasoleo: 1.447, gasolina98: 1.677, distance: 2.0 }
    ];
    return mockData;
}

async function geocodeCity(city) {
    if (!city) {
        console.log('Geocoding: Ciudad vacía, skip');
        return null;
    }

    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(city + ', España')}`;
    console.log('Geocoding con Nominatim:', url);

    try {
        const response = await fetch(url, {
            headers: {
                'Accept-Language': 'es',
                'User-Agent': 'PreciosGasolineras/1.0 (https://example.com)'
            }
        });

        if (!response.ok) {
            throw new Error(`Geocoding HTTP ${response.status}`);
        }

        const list = await response.json();
        console.log('Geocoding response:', list.length, 'resultados');

        if (list.length === 0) {
            console.warn('Geocoding: No se encontró la ciudad');
            return null;
        }

        const result = {
            lat: parseFloat(list[0].lat),
            lng: parseFloat(list[0].lon)
        };
        console.log('Geocoding éxito:', result);
        return result;
    } catch (error) {
        console.warn('Error en geocoding:', error);
        return null;
    }
}

function getCache() {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    try {
        const obj = JSON.parse(raw);
        if (Date.now() - obj.timestamp < CACHE_TTL) {
            return obj.data;
        }
    } catch (error) {
        console.warn('Cache corrupto', error);
    }
    return null;
}

function setCache(data) {
    const cache = {
        timestamp: Date.now(),
        data
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

// Funciones de caché por ciudad
function getCityCache(city) {
    const key = CITY_CACHE_KEY_PREFIX + city.toLowerCase().trim();
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
        const obj = JSON.parse(raw);
        if (Date.now() - obj.timestamp < CITY_CACHE_TTL) {
            return obj.data;
        }
    } catch (error) {
        console.warn('Cache de ciudad corrupto', error);
    }
    return null;
}

function setCityCache(city, data) {
    const key = CITY_CACHE_KEY_PREFIX + city.toLowerCase().trim();
    const cache = {
        timestamp: Date.now(),
        data
    };
    try {
        localStorage.setItem(key, JSON.stringify(cache));
    } catch (error) {
        console.warn('No se pudo guardar cache de ciudad (posiblemente lleno)', error);
    }
}

/**
 * Ordenar y mostrar estaciones según el tipo seleccionado
 */
function sortAndDisplay(sortType) {
    let sortedStations = [...currentStations];

    switch (sortType) {
        case 'gasolina95-asc':
            sortedStations.sort((a, b) => a.gasolina95 - b.gasolina95);
            break;
        case 'gasolina95-desc':
            sortedStations.sort((a, b) => b.gasolina95 - a.gasolina95);
            break;
        case 'distance':
            sortedStations.sort((a, b) => a.distance - b.distance);
            break;
        case 'relevance':
        default:
            // Mantener orden original (por id)
            sortedStations.sort((a, b) => a.id - b.id);
            break;
    }

    currentStations = sortedStations;
    totalPages = Math.max(1, Math.ceil(currentStations.length / pageSize));
    currentPage = 1;
    renderPage();
}

function getActiveSortType() {
    const active = document.querySelector('.sort-btn.active');
    return active ? active.dataset.sort : 'relevance';
}

function applyFuelFilter(stations, fuelType) {
    console.log('applyFuelFilter - fuelType:', fuelType, 'stations count:', stations.length);
    if (!stations || stations.length === 0) {
        console.warn('No hay estaciones para filtrar');
        return [];
    }

    const filtered = stations
        .map((station, index) => ({ ...station, id: index + 1 }))
        .filter(station => {
            const hasPrice = station[fuelType] && station[fuelType] > 0;
            return hasPrice;
        });

    console.log('applyFuelFilter - resultado:', filtered.length);
    return filtered;
}

function updateDistanceForStations(referenceLocation) {
    const ref = referenceLocation || userLocation || cityCenter;
    if (!ref) return;

    currentStations = currentStations.map(station => {
        if (station.latitude && station.longitude) {
            return {
                ...station,
                distance: calculateDistance(ref.lat, ref.lng, station.latitude, station.longitude)
            };
        }
        return station;
    });
}

function renderPage() {
    totalPages = Math.max(1, Math.ceil(currentStations.length / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;

    const start = (currentPage - 1) * pageSize;
    const end = start + pageSize;
    displayedStations = currentStations.slice(start, end);

    console.log('renderPage(): totalPages:', totalPages, 'currentPage:', currentPage);
    
    // Mostrar/ocultar mapa
    const mapElement = document.getElementById('map');
    if (currentStations.length > 0) {
        mapElement.classList.remove('hidden');
        
        // Inicializar mapa si no existe
        if (!map) {
            console.log('Inicializando mapa por primera vez...');
            if (typeof L !== 'undefined') {
                initMap();
            } else {
                console.warn('Leaflet no disponible aún, esperando...');
                // Intentar múltiples veces con intervalos crecientes
                let attempts = 0;
                const maxAttempts = 10;
                const checkLeaflet = () => {
                    attempts++;
                    if (typeof L !== 'undefined') {
                        console.log('Leaflet cargado después de', attempts, 'intentos');
                        initMap();
                    } else if (attempts < maxAttempts) {
                        setTimeout(checkLeaflet, attempts * 200); // Espera creciente: 200ms, 400ms, 600ms...
                    } else {
                        console.error('Leaflet library no se pudo cargar después de', maxAttempts, 'intentos');
                        showError('Error: No se pudo cargar la biblioteca de mapas. Verifica tu conexión a internet.');
                    }
                };
                setTimeout(checkLeaflet, 200);
            }
        } else {
            // Recalcular tamaño si ya existe
            setTimeout(() => map.invalidateSize(), 100);
        }
    } else {
        mapElement.classList.add('hidden');
    }
    
    // Mostrar/ocultar paginación según total de resultados
    const paginationElement = document.getElementById('pagination');
    if (totalPages > 1) {
        paginationElement.classList.remove('hidden');
        console.log('Mostrando controles de paginación');
    } else {
        paginationElement.classList.add('hidden');
        console.log('Ocultando controles de paginación (solo 1 página)');
    }

    pageInfo.textContent = `Página ${currentPage} de ${totalPages}`;
    prevPageBtn.disabled = currentPage <= 1;
    nextPageBtn.disabled = currentPage >= totalPages;
    console.log('Botones: prev.disabled =', prevPageBtn.disabled, ', next.disabled =', nextPageBtn.disabled);

    renderMapMarkers(displayedStations);
    displayStations(displayedStations);
}

function renderMapMarkers(stations) {
    if (!markersLayer || !map) return;

    markersLayer.clearLayers();

    stations.forEach(station => {
        if (!station.latitude || !station.longitude) return;

        const marker = L.marker([station.latitude, station.longitude]);
        const isFavorite = isFavoriteStation(station.id);
        marker.bindPopup(`
            <strong>${station.name}</strong><br>
            ${station.address}<br>
            ${station.distance > 0 ? station.distance.toFixed(2) + ' km' : 'Distancia no disponible'}<br>
            ${station.gasolina95 > 0 ? `95: ${station.gasolina95.toFixed(3)}€` : '95: N/D'}<br>
            ${station.gasolina98 > 0 ? `98: ${station.gasolina98.toFixed(3)}€` : '98: N/D'}<br>
            ${station.gasoleo > 0 ? `Gasóleo: ${station.gasoleo.toFixed(3)}€` : 'Gasóleo: N/D'}<br>
            Favorito: ${isFavorite ? 'Sí' : 'No'}
        `);
        marker.addTo(markersLayer);
    });
}


function calculateDistance(lat1, lon1, lat2, lon2) {
    const toRadian = angle => (Math.PI / 180) * angle;
    const R = 6371;
    const dLat = toRadian(lat2 - lat1);
    const dLon = toRadian(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadian(lat1)) * Math.cos(toRadian(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Number((R * c).toFixed(2));
}

/**
 * Mostrar estaciones de gasolina en la interfaz
 */
function displayStations(stations) {
    resultsContainer.innerHTML = '';

    // Mostrar banner si está usando datos mock
    if (usingMockData) {
        const mockBanner = document.createElement('div');
        mockBanner.style.cssText = `
            background: #fff3cd;
            border: 2px solid #ffc107;
            border-radius: 8px;
            padding: 12px 15px;
            margin-bottom: 15px;
            color: #856404;
            font-weight: 500;
            text-align: center;
        `;
        mockBanner.innerHTML = '⚠️ Usando datos de demostración (API no disponible en este momento)';
        resultsContainer.appendChild(mockBanner);
    }

    const selectedFuel = fuelSelect.value;

    // Crear contenedor de lista
    const listContainer = document.createElement('div');
    listContainer.className = 'stations-list';

    stations.forEach(station => {
        const fuelPrice = station[selectedFuel] && station[selectedFuel] > 0 ? `${station[selectedFuel].toFixed(3)}€` : 'N/D';
        const distanceText = station.distance && station.distance > 0 ? `${station.distance.toFixed(2)} km` : 'Sin ubicación';

        const isFavorite = isFavoriteStation(station.id);
        const favoriteSymbol = isFavorite ? '★' : '☆';

        // Crear elemento de lista compacto
        const listItem = document.createElement('div');
        listItem.className = 'station-list-item';
        listItem.innerHTML = `
            <div class="station-list-header">
                <div class="station-list-name">⛽ ${station.name}</div>
                <div class="station-list-price">${fuelPrice}</div>
                <button class="favorite-btn ${isFavorite ? 'favorito' : ''}" data-id="${station.id}" aria-label="Añadir a favoritos">${favoriteSymbol}</button>
            </div>
            <div class="station-list-details">
                <span class="station-list-address">📍 ${station.address}</span>
                <span class="station-list-distance">${distanceText}</span>
            </div>
        `;

        // Event listener para mostrar detalles
        listItem.addEventListener('click', (e) => {
            // No mostrar detalles si se hizo click en el botón de favorito
            if (e.target.classList.contains('favorite-btn')) return;
            showStationDetail(station, selectedFuel);
        });

        // Event listener para favorito
        const favoriteButton = listItem.querySelector('.favorite-btn');
        if (favoriteButton) {
            favoriteButton.addEventListener('click', (e) => {
                e.stopPropagation(); // Evitar que se abra el detalle
                toggleFavoriteStation(station.id);
                renderPage(); // Recargar la lista
            });
        }

        // Cambiar cursor para indicar que es clickeable
        listItem.style.cursor = 'pointer';
        listItem.title = 'Click para ver detalles';

        listContainer.appendChild(listItem);
    });

    resultsContainer.appendChild(listContainer);

    // Scroll suave hacia los resultados
    resultsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Función para mostrar detalles completos de una gasolinera
function showStationDetail(station, selectedFuel) {
    // Crear modal/overlay para los detalles
    const overlay = document.createElement('div');
    overlay.className = 'station-detail-overlay';
    overlay.innerHTML = `
        <div class="station-detail-modal">
            <div class="station-detail-header">
                <h3>Detalles de la Gasolinera</h3>
                <button class="close-detail-btn" aria-label="Cerrar">&times;</button>
            </div>
            <div class="station-detail-content">
                <div class="station-card station-card-detail">
                    <div class="station-favorite">
                        <button class="favorite-btn ${isFavoriteStation(station.id) ? 'favorito' : ''}" data-id="${station.id}" aria-label="Añadir a favoritos">
                            ${isFavoriteStation(station.id) ? '★' : '☆'}
                        </button>
                    </div>
                    <div class="station-name">⛽ ${station.name}</div>
                    <div class="station-address">📍 ${station.address}</div>
                    <div class="station-address" style="font-size: 0.85rem; color: #999;">
                        Distancia: ${station.distance && station.distance > 0 ? `${station.distance.toFixed(2)} km` : 'Sin ubicación'}
                    </div>
                    <div class="price-group">
                        <span class="price-label">Precio ${selectedFuel.replace('gasolina', 'Gasolina ').replace('gasoleo', 'Gasóleo ').trim()}</span>
                        <span class="price-value">${station[selectedFuel] && station[selectedFuel] > 0 ? `${station[selectedFuel].toFixed(3)}€` : 'N/D'}</span>
                    </div>
                    <div class="price-group">
                        <span class="price-label">Gasolina 95</span>
                        <span class="price-value">${station.gasolina95 > 0 ? station.gasolina95.toFixed(3) + '€' : 'N/D'}</span>
                    </div>
                    <div class="price-group">
                        <span class="price-label">Gasolina 98</span>
                        <span class="price-value">${station.gasolina98 > 0 ? station.gasolina98.toFixed(3) + '€' : 'N/D'}</span>
                    </div>
                    <div class="price-group">
                        <span class="price-label">Gasóleo</span>
                        <span class="price-value">${station.gasoleo > 0 ? station.gasoleo.toFixed(3) + '€' : 'N/D'}</span>
                    </div>
                    <div class="station-actions">
                        <button class="center-map-btn" ${station.latitude && station.longitude ? '' : 'disabled'}>
                            📍 Centrar en mapa
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Event listeners
    const closeBtn = overlay.querySelector('.close-detail-btn');
    const favoriteBtn = overlay.querySelector('.favorite-btn');
    const centerMapBtn = overlay.querySelector('.center-map-btn');

    // Cerrar modal
    closeBtn.addEventListener('click', () => {
        document.body.removeChild(overlay);
    });

    // Click fuera del modal para cerrar
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            document.body.removeChild(overlay);
        }
    });

    // Toggle favorito
    favoriteBtn.addEventListener('click', () => {
        toggleFavoriteStation(station.id);
        const isFav = isFavoriteStation(station.id);
        favoriteBtn.textContent = isFav ? '★' : '☆';
        favoriteBtn.classList.toggle('favorito', isFav);
        renderPage(); // Actualizar la lista
    });

    // Centrar mapa
    centerMapBtn.addEventListener('click', () => {
        if (station.latitude && station.longitude && map) {
            console.log('Centrando mapa en:', station.name, [station.latitude, station.longitude]);
            map.setView([station.latitude, station.longitude], 16);
            
            // Abrir popup correspondiente
            if (markersLayer) {
                markersLayer.eachLayer((layer) => {
                    if (layer instanceof L.Marker) {
                        const markerLatLng = layer.getLatLng();
                        if (Math.abs(markerLatLng.lat - station.latitude) < 0.001 && 
                            Math.abs(markerLatLng.lng - station.longitude) < 0.001) {
                            layer.openPopup();
                        }
                    }
                });
            }
        }
        document.body.removeChild(overlay); // Cerrar modal después de centrar
    });

    // Agregar al body
    document.body.appendChild(overlay);
}

function getFavoriteStations() {
    const raw = localStorage.getItem('gasolineras-favoritas');
    if (!raw) return [];
    try {
        return JSON.parse(raw);
    } catch (error) {
        console.warn('Error leyendo favoritos', error);
        return [];
    }
}

function isFavoriteStation(id) {
    const favorites = getFavoriteStations();
    return favorites.includes(id);
}

function toggleFavoriteStation(id) {
    const favorites = getFavoriteStations();
    const index = favorites.indexOf(id);

    if (index === -1) {
        favorites.push(id);
    } else {
        favorites.splice(index, 1);
    }

    localStorage.setItem('gasolineras-favoritas', JSON.stringify(favorites));
}

function setLocationStatus(text, status) {
    locationStatus.textContent = text;
    locationStatus.className = 'location-status';
    if (status === 'activado') {
        locationStatus.classList.add('activado');
    } else if (status === 'error') {
        locationStatus.classList.add('error');
    }
}

/**
 * Mostrar/ocultar spinner de carga
 */
function showLoading(show) {
    if (show) {
        loadingSpinner.classList.remove('hidden');
    } else {
        loadingSpinner.classList.add('hidden');
    }
}

/**
 * Mostrar mensaje de error
 */
function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.remove('hidden');
}

/**
 * Limpiar mensaje de error
 */
function clearError() {
    errorMessage.classList.add('hidden');
    errorMessage.textContent = '';
}

// Log de inicialización
console.log('Aplicación de Gasolineras cargada y lista');
