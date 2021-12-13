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
        logLevel: 'error',
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

        socket.join(room)

        io.to(socket.id).emit('rtp-capabilities', {
            rtpCapabilities: routers[room].rtpCapabilities,
            isCreator
        })
    })

    socket.on('web-rtc-transport', async ({ room }, callback) => {
        transports[room] = {
            ...transports[room],
            [socket.id]: {
                producerTransport: await createWebRtcTransport(room, socket.id, callback)
            }
        }

        console.log('transports', transports)
    })

    socket.on('transport-connect', async ({ dtlsParameters, consumerId, isConsumer, room }) => {
        console.log('dtlsParameters recieved from socket', socket.id)
        
        if(isConsumer) {
            await transports[room][socket.id].consumersList[consumerId].consumerTransport.connect({ dtlsParameters })

        } else {
            await transports[room][socket.id]['producerTransport'].connect({ dtlsParameters })
        }
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

        // Inform everyone of new participant, and new participant of other participants
        // AFTER new participant's producer has been made on server and locally
        let otherParticipants = []

        otherParticipants = Object.keys(transports[room]).filter(id => id !== socket.id);

        if(otherParticipants.length > 0) {
            // Send list of participants to
            io.to(socket.id).emit('other-participants', { otherParticipants })
    
            otherParticipants.forEach(socketId => {
                io.to(socketId).emit('new-participant', {
                    participantSocketId: socket.id
                })
            })
        }

        console.log('transports', transports)

        callback({ id: socketProducer.id })
    })

    socket.on('consume-participant', async({ rtpCapabilities, participantSocketId, room }, callback) => {
        try {
            let producer = transports[room][participantSocketId]['producer']
            
            if(routers[room].canConsume({
                producerId: producer.id,
                rtpCapabilities
            })) {

                if( !transports[room][socket.id].consumersList ) {
                    transports[room][socket.id] = {
                        ...transports[room][socket.id],
                        consumersList: {}
                    }
                }

                let tempConsumerTransport = await createWebRtcTransport(room, socket.id, undefined)

                let tempConsumerTransportParams = {
                    id: tempConsumerTransport.id,
                    iceParameters: tempConsumerTransport.iceParameters,
                    iceCandidates: tempConsumerTransport.iceCandidates,
                    dtlsParameters: tempConsumerTransport.dtlsParameters,
                }

                let tempConsumer = await tempConsumerTransport.consume({
                    producerId: producer.id,
                    rtpCapabilities,
                    paused: true
                })

                transports[room][socket.id].consumersList = {
                    ...transports[room][socket.id].consumersList,
                    [tempConsumer.id]: {
                        consumerTransport: tempConsumerTransport,
                        consumer: tempConsumer,
                    }
                }

                tempConsumer.on('transportclose', () => {
                    console.log('Transport for', socket.id, 'has closed')
                })

                tempConsumer.on('producerclose', () => {
                    console.log('Producer of', socket.id, 'consumer has closed')
                })

                console.log('Consumer', tempConsumer.id, 'created')
                console.log('transports', transports)

                callback({
                    params: {
                        id: tempConsumer.id,
                        producerId: producer.id,
                        kind: tempConsumer.kind,
                        rtpParameters: tempConsumer.rtpParameters,
                        consumerTransportParams: tempConsumerTransportParams,
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

    socket.on('consumer-resume', async({ consumerId, room }) => {
        transports[room][socket.id].consumersList[consumerId].consumer.resume()
    })

    socket.on('disconnect', () => {
        console.log(socket.id, 'disconnected')

        Object.keys(transports).forEach(room => {
            delete transports[room][socket.id]
        })
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

        if(callback) {
            callback({
                params: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters,
                }
            })
        }

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