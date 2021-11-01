const mediasoupClient = require('mediasoup-client')

const submitButton = document.getElementById("submit-button")
const localVideo = document.getElementById("local")
const message = document.getElementById("message")
const roomField = document.getElementById("roomNum")
const inputField = document.getElementById("roomInfo")
const videoFeed = document.getElementById("videos")

const toggelButtons = document.getElementById("toggle-buttons")
const toggelVideo = document.getElementById("toggle-video")
const toggelAudio = document.getElementById("toggle-audio")

const socket = io('http://localhost:3000')

let roomName
let device
let producerTransport

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

let params = {
    // mediasoup params
}

submitButton.onclick = async() => {
    message.style = "display: none"
    inputField.style = "display: none"
    videoFeed.style = "display: flex"
    toggelButtons.style = "display: block"

    let stream = await navigator.mediaDevices.getUserMedia(mediaConstraints)
    localStream = stream
    localVideo.srcObject = stream
    localVideo.muted = true

    stream.getTracks().forEach(track => {
        params[track.kind] = track
        // if(track.kind == 'video') {
        //     params = {
        //         video: track,
        //         ...params
        //     }
        // } else {
        //     params = {
        //         audio: track,
        //         ...params
        //     }
        // }
    })

    roomName = roomField.value
    socket.emit("create-or-join", roomName)
}

const createDevice = async(rtpCapabilities) => {
    device = new mediasoupClient.Device()
    await device.load({ routerRtpCapabilities: rtpCapabilities })

    console.log('Device created:', device)

    socket.emit('web-rtc-transport', { sender: true, room: roomName }, ({ params }) => {
        // Callback fires when we get transport parameters on the server-side after it's created
        if(params.error) {
            console.log(params.error)
            return
        }

        console.log('Transport params recieved:', params)

        // Create local send transport
        producerTransport = device.createSendTransport(params)

        producerTransport.on('connect', async({ dtlsParameters }, callback, errback) => {
            try {
                // Send local DTLS transport paramters to server-side trasnport
                await socket.emit('transport-connect', {
                    transportId: producerTransport.id,
                    dtlsParameters
                })

                // Tell the local transport that paramters were submitted to server-side
                callback()
            } catch (error) {
                errback(error)
            }
        })

        producerTransport.on('produce', async(parameters, callback, errback) => {
            console.log(parameters)

            await socket.emit('transport-produce', {
                transportId: producerTransport.id,
                kind: parameters.kind,
                rtpParameters: parameters.rtpParameters,
                appData: parameters.appData

            }, ({ id }) => {
                // On socket.io callback tell local transport that parameters were submitted to server-side
                // and provide it with server-side's transport's id
                callback({ id })
            })
            try {
                
            } catch (error) {
                errback(error)
            }
        })
    })
}

socket.on('rtp-capabilities', async(data) => {
    let rtpCapabilities = data.rtpCapabilities
    await createDevice(rtpCapabilities)
})

// Video and Audio button toggles

toggelVideo.onclick = () => {
    let localStreamVidTracks = localStream.getVideoTracks()
    
    if(toggelVideo.innerHTML == "Video On") {
        localStreamVidTracks.forEach(track => {
            track.enabled = false
        })
        toggelVideo.innerHTML = "Video Off"
        toggelVideo.style.backgroundColor = "rgb(255, 0, 0)"

    } else {
        localStreamVidTracks.forEach(track => {
            track.enabled = true
        })
        toggelVideo.innerHTML = "Video On"
        toggelVideo.style.backgroundColor = "rgb(0, 255, 0)"
    }
}

toggelAudio.onclick = () => {
    let localStreamAudioTracks = localStream.getAudioTracks()
    
    if(toggelAudio.innerHTML == "Audio On") {
        localStreamAudioTracks.forEach(track => {
            track.enabled = false
        })
        toggelAudio.innerHTML = "Audio Off"
        toggelAudio.style.backgroundColor = "rgb(255, 0, 0)"

    } else {
        localStreamAudioTracks.forEach(track => {
            track.enabled = true
        })
        toggelAudio.innerHTML = "Audio On"
        toggelAudio.style.backgroundColor = "rgb(0, 255, 0)"
    }
}
