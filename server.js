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

const createWorker = async () => {
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
let transports = {}
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
    },
    {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'level-asymmetry-allowed': 1,
          'profile-level-id': "42e01f",
        }
    }    
]

io.on('connection', async (socket) => {

    socket.on('create-or-join', async (room) => {

        let isCreator

        // if room exists
        if (routers[room]) {
            isCreator = false
        } else {
            let newRouter = await worker.createRouter({ mediaCodecs })
            routers[room] = newRouter

            isCreator = true

            console.log('New router added', routers)
        }

        io.to(socket.id).emit('rtp-capabilities', {
            rtpCapabilities: routers[room].rtpCapabilities,
            isCreator
        })
    })

    socket.on('web-rtc-transport', async ({ sender, room }, callback) => {
        if (sender) {
            transports[room] = {
                ...transports[room],
                [socket.id]: {
                    producerTransport: await createWebRtcTransport(room, socket.id, callback)
                }
            }
        } else {
            transports[room] = {
                ...transports[room],
                [socket.id]: {
                    consumerTransport: await createWebRtcTransport(room, socket.id, callback)
                }
            }
        }

        console.log('transports', transports)
    })

    socket.on('transport-connect', async ({ dtlsParameters, isCreator, room }) => {
        console.log('dtlsParameters recieved from socket', socket.id)
        if(isCreator)
            await transports[room][socket.id]['producerTransport'].connect({ dtlsParameters })
        else
            await transports[room][socket.id]['consumerTransport'].connect({ dtlsParameters })
    })

    socket.on('transport-produce', async ({ room, kind, rtpParameters, appData }, callback) => {
        let socketProducerTransport = transports[room][socket.id]['producerTransport']

        transports[room][socket.id]['producer'] = await socketProducerTransport.produce({
            kind, rtpParameters
        })
        let socketProducer = transports[room][socket.id]['producer']

        socketProducer.on('transportclose', () => {
            console.log('Transport for', socket.id, 'has closed')
            socketProducer.close()
        })

        console.log('transports', transports)

        callback({ id: socketProducer.id })
    })

    socket.on('consume', async({ rtpCapabilities, room }, callback) => {
        try {
            let producerSocketId = Object.keys(transports[room]).filter(item => item !== socket.id)
            let producer = transports[room][producerSocketId]['producer']
            
            if(routers[room].canConsume({
                producerId: producer.id,
                rtpCapabilities
            })) {
                transports[room][socket.id]['consumer'] = await transports[room][socket.id]['consumerTransport'].consume({
                    producerId: producer.id,
                    rtpCapabilities,
                    paused: true
                })

                let tempConsumer = transports[room][socket.id]['consumer']

                tempConsumer.on('transportclose', () => {
                    console.log('Transport for', socket.id, 'has closed')
                })

                tempConsumer.on('producerclose', () => {
                    console.log('Producer of', socket.id, 'consumer has closed')
                })

                const params = {
                    id: tempConsumer.id,
                    producerId: producer.id,
                    kind: tempConsumer.kind,
                    rtopParameters: tempConsumer.rtpParameters
                }

                console.log('Consumer', tempConsumer.id, 'created')
                console.log('transports', transports)

                callback({
                    params: {
                        id: tempConsumer.id,
                        producerId: producer.id,
                        kind: tempConsumer.kind,
                        rtpParameters: tempConsumer.rtpParameters
                    }
                })
            }

        } catch(error) {
            console.log('Error on consume', error.message)
            callback({
                params: {
                    error
                }
            })
        }
    })

    socket.on('consumer-resume', async({ room }) => {
        transports[room][socket.id]['consumer'].resume()
    })

    socket.on('disconnect', () => {
        console.log(socket.id, 'disconnected')
    })
})

const createWebRtcTransport = async (room, currSocketId, callback) => {
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
            if (dtlsState === 'closed') {
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
                dtlsParameters: transport.dtlsParameters,
                // otherSocketIds: Object.keys(transports[room]).filter(id => id !== currSocketId)
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