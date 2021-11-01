const express = require('express')
let cors = require('cors')
const app = express(cors())

let http = require('http').Server(app)
let io = require('socket.io')(http, {
    cors: {
      origin: '*',
    }
})

const port = process.env.PORT || 3000

const mediasoup = require('mediasoup')

let worker

const createWorker = async() => {
    worker = await mediasoup.createWorker({
        rtcMinPort: 10000,
        rtcMaxPort: 59999,
    })

    console.log('Worker', worker.pid, 'created')

    worker.on('died', error => {
        console.log('Worker', worker.pid, 'died', err)
        setTimeout(() => process.exit(1), 2000)
    })
}
createWorker()

app.use(express.static('public'))

http.listen(port, () => {
    console.log('Server listening on', port)
})

let producerTransport, consumerTransport
let routers = {}
let mediaCodecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
            'x-google-start-bitrate': 1000
        }
    }
]

io.on('connection', async(socket) => {
    
    socket.on('create-or-join', async(room) => {

        if (routers[room] == undefined) {
            let newRouter = await worker.createRouter({ mediaCodecs })
            routers[room] = newRouter

            console.log(routers)
        } else {
            
        }

        io.to(socket.id).emit('rtp-capabilities', {
            rtpCapabilities: routers[room].rtpCapabilities
        })
    })

    socket.on('web-rtc-transport', async({ sender, room }, callback) => {
        if(sender) {
            producerTransport = await createWebRtcTransport(room, callback)
        } else {
            consumerTransport = await createWebRtcTransport(room, callback)
        }
    })

    socket.on('disconnect', () => {
        console.log(socket.id, 'disconnected')
    })
})

const createWebRtcTransport = async(room, callback) => {
    try {
        const webRtcTransportOptions = {
            listenIps: [
                {
                  ip: '0.0.0.0', // replace with server's public IP address
                  announcedIp: '127.0.0.1',
                }
            ],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
        }
    
        let transport = await routers[room].createWebRtcTransport(webRtcTransportOptions)
        console.log('Transport', transport.id, 'created')
    
        transport.on('dtlsstatechange', dtlsState => {
            if(dtlsState === 'closed') {
                transport.close()
            }
        })
    
        transport.on('close', () => {
            console.log('Transport', transport.id, 'closed')
        })

        callback({
            params: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters
            }
        })

        return transport
        
    } catch (error) {
        console.log(error)

        // Callback to client with error
        callback({
            params: {
                error: error
            }
        })
    }
}