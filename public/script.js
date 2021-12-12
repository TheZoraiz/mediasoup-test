const mediasoupClient = require('mediasoup-client')

const submitButton = document.getElementById("submit-button")
const localVideo = document.getElementById("local")
const message = document.getElementById("message")
const roomField = document.getElementById("roomNum")
const inputField = document.getElementById("roomInfo")
const videoFeed = document.getElementById("videos")

const toggleButtons = document.getElementById("toggle-buttons")
const toggleVideo = document.getElementById("toggle-video")
const toggleAudio = document.getElementById("toggle-audio")

const socket = io('http://localhost:3000')

let roomName
let device
let routerRtpCapabilities
let producerTransport
let localProducer
let isCreator
let consumers = []

socket.on('connected', ({ socketId }) => {
    console.log(socketId)
})

const mediaConstraints = {
    video: {
        width: { max: 640 },
        height: { max: 480 },
    },
    audio: {
        echoCancellation: true
    }
}

let globalParams = {
    // mediasoup params
    encoding: [
        {
            rid: 'r0',
            maxBitrate: 100000,
            scalabilityMode: 'S1T3',
        },
        {
            rid: 'r1',
            maxBitrate: 300000,
            scalabilityMode: 'S1T3',
        },
        {
            rid: 'r2',
            maxBitrate: 900000,
            scalabilityMode: 'S1T3',
        },
    ],
    codecOptions: {
        videoGoogleStartBitrate: 1000,
    }
}

submitButton.onclick = async() => {
    message.style = "display: none"
    inputField.style = "display: none"
    videoFeed.style = "display: flex"
    toggleButtons.style = "display: block"

    try {
        let stream = await navigator.mediaDevices.getUserMedia(mediaConstraints)
        localVideo.srcObject = stream
        localVideo.muted = true
    
        let track = stream.getVideoTracks()[0]
    
        globalParams = {
            track,
            ...globalParams,
        }
       console.log('globalParams', globalParams)

       roomName = roomField.value
       socket.emit("create-or-join", roomName)

    } catch(error) {
        console.error('Couldn\'t get local media stream', error)
    }   
}

socket.on('rtp-capabilities', async(data) => {
    routerRtpCapabilities = data.rtpCapabilities
    isCreator = data.isCreator
    await createDevice()
})

const createDevice = async() => {
    device = new mediasoupClient.Device()
    await device.load({ routerRtpCapabilities: routerRtpCapabilities })

    console.log('Device created', device)

    socket.emit('web-rtc-transport', { sender: isCreator, room: roomName }, async({ params }) => {
        // Callback fires when we get transport parameters on the server-side after it's created
        if(params.error) {
            console.log(params.error)
            return
        }

        console.log('Router transport params recieved', params)

        console.log('isCreator', isCreator)
        if(isCreator) {
            // Create local send transport
            producerTransport = await device.createSendTransport(params)
            assignProducerTransportEvents()
            console.log('producerTransport', producerTransport)

            localProducer = await producerTransport.produce(globalParams)
            assignProducerEvents()
            console.log('localProducer', localProducer)

        } else {
            let tempConsumer = {}
            // Create receive send transport
            tempConsumer['consumerTransport'] = await device.createRecvTransport(params)
            assignConsumerTransportEvents(tempConsumer.consumerTransport)
            console.log('consumerTransport', tempConsumer.consumerTransport)

            await socket.emit('consume', { rtpCapabilities: device.rtpCapabilities, room: roomName }, async({ params }) => {
                if(params && params.error) {
                    console.log(params.error)
                    return
                }
        
                console.log('Received params after \'consume\'', params)

                tempConsumer['consumer'] = await tempConsumer.consumerTransport.consume({
                    id: params.id,
                    producerId: params.producerId,
                    kind: params.kind,
                    rtpParameters: params.rtpParameters
                })
                consumers.push(tempConsumer)
                console.log('consumers array', consumers)

                const { track } = tempConsumer.consumer;

                console.log('Recieved track', track)
    
                let remoteVid = document.createElement('video')
                remoteVid.srcObject = new MediaStream([track]);
                remoteVid.id = params.producerId
                remoteVid.autoplay = true

                videoFeed.appendChild(remoteVid)

                socket.emit('consumer-resume', { room: roomName })
            })
        }

    })
}


const assignProducerTransportEvents = () => {
    producerTransport.on('connect', async({ dtlsParameters }, callback, errback) => {
        try {
            // Send local DTLS transport paramters to server-side transport
            await socket.emit('transport-connect', {
                // transportId: producerTransport.id,
                dtlsParameters,
                room: roomName,
                isCreator
            })

            // Tell the local transport that paramters were submitted to server-side
            callback()
        } catch (error) {
            errback(error)
        }
    })

    producerTransport.on('produce', async(parameters, callback, errback) => {
        console.log('Local \'producerTransport\' parameters', parameters)

        try {
            await socket.emit('transport-produce', {
                // transportId: producerTransport.id,
                kind: parameters.kind,
                rtpParameters: parameters.rtpParameters,
                appData: parameters.appData,
                room: roomName

            }, ({ id }) => {
                // On socket.io callback, tell local transport that parameters were submitted to server-side
                // and provide it with server-side's transport's id
                callback({ id })
            })
        } catch (error) {
            errback(error)
        }
    })
}

const assignProducerEvents = () => {
    localProducer.on('trackended', () => {
        // Close video track
        console.log('Track ended...')
    })

    localProducer.on('transportclose', () => {
        // Close video track
        console.log('Transport closed...')
    })
}

const assignConsumerTransportEvents = (consumerTransport) => {
    
    consumerTransport.on('connect', async({ dtlsParameters }, callback, errback) => {
        try {
            // Send local DTLS transport paramters to server-side transport
            await socket.emit('transport-connect', {
                dtlsParameters,
                room: roomName,
                isCreator
            })

            // Tell the local transport that paramters were submitted to server-side
            callback()
        } catch (error) {
            errback(error)
        }
    })
}

const assignConsumerEvents = (consumer) => {
    localProducer.on('trackended', () => {
        // Close video track
        console.log('Track ended...')
    })

    localProducer.on('transportclose', () => {
        // Close video track
        console.log('Transport closed...')
    })
}

// Video and Audio button toggles

toggleVideo.onclick = () => {
    let localStreamVidTracks = localStream.getVideoTracks()
    
    if(toggleVideo.innerHTML == "Video On") {
        localStreamVidTracks.forEach(track => {
            track.enabled = false
        })
        toggleVideo.innerHTML = "Video Off"
        toggleVideo.style.backgroundColor = "rgb(255, 0, 0)"

    } else {
        localStreamVidTracks.forEach(track => {
            track.enabled = true
        })
        toggleVideo.innerHTML = "Video On"
        toggleVideo.style.backgroundColor = "rgb(0, 255, 0)"
    }
}

toggleAudio.onclick = () => {
    let localStreamAudioTracks = localStream.getAudioTracks()
    
    if(toggleAudio.innerHTML == "Audio On") {
        localStreamAudioTracks.forEach(track => {
            track.enabled = false
        })
        toggleAudio.innerHTML = "Audio Off"
        toggleAudio.style.backgroundColor = "rgb(255, 0, 0)"

    } else {
        localStreamAudioTracks.forEach(track => {
            track.enabled = true
        })
        toggleAudio.innerHTML = "Audio On"
        toggleAudio.style.backgroundColor = "rgb(0, 255, 0)"
    }
}
