import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import Twilio from 'twilio';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import admin from 'firebase-admin';

// Load environment variables from .env file
dotenv.config();

// Check for required environment variables
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  TOKEN,
  FIREBASE_DATABASE_URL
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER ||
  !TOKEN ||
  !FIREBASE_DATABASE_URL
) {
  console.error('Missing required environment variables');
  throw new Error('Missing required environment variables');
}

// Initialize Firebase Admin
const serviceAccountPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'firebase-key.json');
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

// Get a reference to the Realtime Database
const database = admin.database();
console.log('[Firebase] Realtime Database connected');

// Helper function to log messages to Firebase
const logToFirebase = async (phoneNumber, message, source) => {
  if (!phoneNumber) {
    console.error('[Firebase] Cannot log message: Phone number is missing');
    return;
  }

  try {
    // Create a sanitized phone number to use as a key (remove + and other special chars)
    const sanitizedPhoneNumber = phoneNumber.replace(/[^\w\s]/gi, '');
    
    // Create a reference to the conversation
    const conversationRef = database.ref(`conversations/${sanitizedPhoneNumber}`);
    
    // Ensure conversation metadata exists
    await conversationRef.update({
      phoneNumber: phoneNumber,
      startTime: admin.database.ServerValue.TIMESTAMP,
      lastUpdated: admin.database.ServerValue.TIMESTAMP,
      status: 'active'
    });
    
    // Add the log entry
    const logsRef = conversationRef.child('logs');
    await logsRef.push({
      message,
      source, // 'agent', 'human', or 'system'
      timestamp: admin.database.ServerValue.TIMESTAMP
    });
    
    console.log(`[Firebase] Logged ${source} message for ${phoneNumber}`);
  } catch (error) {
    console.error('[Firebase] Error logging message:', error);
    // If Firebase logging fails, don't let it break the application
    // Just log the error and continue
  }
};

// Helper function to clear logs for a phone number
const clearLogsForPhoneNumber = async (phoneNumber) => {
  if (!phoneNumber) {
    console.error('[Firebase] Cannot clear logs: Phone number is missing');
    return;
  }

  try {
    // Create a sanitized phone number to use as a key
    const sanitizedPhoneNumber = phoneNumber.replace(/[^\w\s]/gi, '');
    
    // Create a reference to the logs for this phone number
    const logsRef = database.ref(`conversations/${sanitizedPhoneNumber}/logs`);
    
    // Remove all logs
    await logsRef.remove();
    console.log(`[Firebase] Cleared logs for ${phoneNumber}`);
    
    // Update the conversation metadata to show this is a new call
    const conversationRef = database.ref(`conversations/${sanitizedPhoneNumber}`);
    await conversationRef.update({
      startTime: admin.database.ServerValue.TIMESTAMP,
      lastUpdated: admin.database.ServerValue.TIMESTAMP,
      status: 'active'
    });
  } catch (error) {
    console.error('[Firebase] Error clearing logs:', error);
  }
};

// Helper function to store dynamic variables
const storeVariables = (phoneNumber, variables) => {
  try {
    // Use import.meta.url to get current file path in ES modules
    const __filename = new URL(import.meta.url).pathname;
    const storagePath = path.join(path.dirname(__filename), 'variables-storage.json');
    
    let storage = {};
    
    // Read existing storage if it exists
    if (fs.existsSync(storagePath)) {
      const data = fs.readFileSync(storagePath, 'utf8');
      storage = JSON.parse(data);
    }
    
    // Update storage with new variables
    storage[phoneNumber] = variables;
    
    // Write back to file
    fs.writeFileSync(storagePath, JSON.stringify(storage, null, 2));
    console.log(`[Storage] Variables stored for ${phoneNumber}`);
    return true;
  } catch (error) {
    console.error('[Storage] Failed to store variables:', error);
    return false;
  }
};

// Helper function to retrieve dynamic variables
const retrieveVariables = (phoneNumber) => {
  try {
    // Use import.meta.url to get current file path in ES modules
    const __filename = new URL(import.meta.url).pathname;
    const storagePath = path.join(path.dirname(__filename), 'variables-storage.json');
    
    // If storage doesn't exist, return empty object
    if (!fs.existsSync(storagePath)) {
      return null;
    }
    
    // Read and parse storage
    const data = fs.readFileSync(storagePath, 'utf8');
    const storage = JSON.parse(data);
    
    // Return variables for this phone number if exists
    if (storage[phoneNumber]) {
      console.log(`[Storage] Retrieved variables for ${phoneNumber}`);
      return storage[phoneNumber];
    }
    
    return null;
  } catch (error) {
    console.error('[Storage] Failed to retrieve variables:', error);
    return null;
  }
};

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl(phoneNumberParam) {
  try {
    // Get the current phone number context from global variables
    let agentId = ELEVENLABS_AGENT_ID; // Default to environment variable
    
    // Check if we have a phone number and can retrieve stored variables
    const numberToUse = phoneNumberParam || (typeof phoneNumber === 'string' && phoneNumber ? phoneNumber : null);
    
    if (numberToUse) {
      const storedVariables = retrieveVariables(numberToUse);
      if (storedVariables && storedVariables.elevenlabs_agent_id) {
        agentId = storedVariables.elevenlabs_agent_id;
        console.log(`[ElevenLabs] Using agent ID from stored variables: ${agentId}`);
      }
    }
    console.log(`[ElevenLabs] Current agent id: ${agentId}`);

    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
      {
        method: 'GET',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error('Error getting signed URL:', error);
    throw error;
  }
}

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(fastifyCors, {
  origin: '*', // In production, you might want to restrict this to specific domains
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
});

const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get('/', async (_, reply) => {
  reply.send({ message: 'Server is running' });
});

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Route to initiate outbound calls
fastify.post('/outbound-call', async (request, reply) => {
  const { number, prompt, first_message, dynamic_variables, token, elevenlabs_agent_id } = request.body;

  // Verify token
  if (!token || token !== TOKEN) {
    console.error('[Security] Invalid token provided for outbound call. Access denied.');
    return reply.code(401).send({ 
      success: false,
      error: 'Unauthorized. Invalid token.'
    });
  }

  if (!number) {
    return reply.code(400).send({ error: 'Phone number is required' });
  }

  // Create variables object to store 
  const variablesToStore = {};
  
  // Store dynamic variables if provided
  if (dynamic_variables) {
    Object.assign(variablesToStore, dynamic_variables);
  }
  
  // Store ElevenLabs agent ID if provided
  if (elevenlabs_agent_id) {
    variablesToStore.elevenlabs_agent_id = elevenlabs_agent_id;
  }
  
  // Store prompt in variables storage (bridge approach)
  if (prompt) {
    variablesToStore.prompt = prompt;
  }
  
  // Store first_message in variables storage (bridge approach)
  if (first_message) {
    variablesToStore.first_message = first_message;
  }
  
  // Store all variables if we have any
  if (Object.keys(variablesToStore).length > 0) {
    storeVariables(number, variablesToStore);
  }

  try {
    // Use "none" placeholder for prompt and first_message when passing to Twilio
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${request.headers.host}/outbound-call-twiml?prompt=${encodeURIComponent(
        "none"
      )}&first_message=${encodeURIComponent(
        "none"
      )}&phone=${encodeURIComponent(number)}`,
    });

    reply.send({
      success: true,
      message: 'Call initiated',
      callSid: call.sid,
    });
  } catch (error) {
    console.error('Error initiating outbound call:', error);
    reply.code(500).send({
      success: false,
      error: 'Failed to initiate call',
    });
  }
});

// TwiML route for outbound calls
fastify.all('/outbound-call-twiml', async (request, reply) => {
  const prompt = request.query.prompt || '';
  const first_message = request.query.first_message || '';
  const phone = request.query.phone || '';

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Connect>
        <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
            <Parameter name="first_message" value="${first_message}" />
            <Parameter name="phone" value="${phone}" />
        </Stream>
        </Connect>
    </Response>`;

  reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for handling media streams
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get('/outbound-media-stream', { websocket: true }, (ws, req) => {
    console.info('[Server] Twilio connected to outbound media stream');

    // Variables to track the call
    let streamSid = null;
    let callSid = null;
    let elevenLabsWs = null;
    let customParameters = null; // Add this to store parameters
    let phoneNumber = null;

    // Handle WebSocket errors
    ws.on('error', console.error);

    // Set up ElevenLabs connection
    const setupElevenLabs = async () => {
      try {
        
        const signedUrl = await getSignedUrl(phoneNumber);
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on('open', () => {
          console.log('[ElevenLabs] Connected to Conversational AI');
          
          // If phone number is available, try to load dynamic variables
          if (phoneNumber && customParameters) {
            const storedVariables = retrieveVariables(phoneNumber);
            if (storedVariables) {
              // Merge stored variables into customParameters.dynamic_variables
              customParameters.dynamic_variables = {
                ...(customParameters.dynamic_variables || {}),
                ...storedVariables
              };
              console.log('[Storage] Retrieved dynamic variables for', phoneNumber);
            }
          }

          console.log('[DEBUG] Dynamic Variables:');
          console.log(customParameters?.dynamic_variables);

          // Get the prompt from storage if available (bridge approach)
          let promptText = '';
          let firstMessageText = '';
          
          if (phoneNumber) {
            const storedVariables = retrieveVariables(phoneNumber);
            if (storedVariables) {
              if (storedVariables.prompt) {
                promptText = storedVariables.prompt;
                console.log('[Storage] Retrieved prompt from bridge storage for', phoneNumber);
              }
              
              if (storedVariables.first_message) {
                firstMessageText = storedVariables.first_message;
                console.log('[Storage] Retrieved first_message from bridge storage for', phoneNumber);
              }
            }
          }

          // Send initial configuration with prompt and first message
          const initialConfig = {
            type: 'conversation_initiation_client_data',
            dynamic_variables: customParameters?.dynamic_variables || {},
            conversation_config_override: {
              agent: {
                prompt: {
                  prompt: promptText,
                },
                first_message: firstMessageText,
              },
            },
          };

          console.log(
            '[ElevenLabs] Sending initial config with prompt:',
            initialConfig.conversation_config_override.agent.prompt.prompt
          );

          // Send the configuration to ElevenLabs
          elevenLabsWs.send(JSON.stringify(initialConfig));
        });

        elevenLabsWs.on('message', (data) => {
          try {
            const message = JSON.parse(data);

            switch (message.type) {
              case 'conversation_initiation_metadata':
                console.log('[ElevenLabs] Received initiation metadata');
                logToFirebase(phoneNumber, 'Received initiation metadata', 'system');
                break;

              case 'audio':
                if (streamSid) {
                  if (message.audio?.chunk) {
                    const audioData = {
                      event: 'media',
                      streamSid,
                      media: {
                        payload: message.audio.chunk,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  } else if (message.audio_event?.audio_base_64) {
                    const audioData = {
                      event: 'media',
                      streamSid,
                      media: {
                        payload: message.audio_event.audio_base_64,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  }
                } else {
                  console.log('[ElevenLabs] Received audio but no StreamSid yet');
                }
                break;

              case 'agent_response':
                console.log('[ElevenLabs] Agent Response:', message.agent_response_event?.agent_response);
                logToFirebase(phoneNumber, message.agent_response_event?.agent_response, 'agent');
                break;

              case 'interruption':
                console.log('[ElevenLabs] Human interrupted');
                logToFirebase(phoneNumber, 'Human interrupted', 'system');
                
                // Send clear event to Twilio to handle interruption
                if (streamSid) {
                  ws.send(
                    JSON.stringify({
                      event: 'clear',
                      streamSid,
                    })
                  );
                }
                break;

              case 'ping':
                if (message.ping_event?.event_id) {
                  elevenLabsWs.send(
                    JSON.stringify({
                      type: 'pong',
                      event_id: message.ping_event.event_id,
                    })
                  );
                }
                break;

              case 'user_transcript':
                console.log(
                  `[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`
                );
                logToFirebase(phoneNumber, message.user_transcription_event?.user_transcript, 'human');
                break;

              default:
                console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
                logToFirebase(phoneNumber, `Unhandled message type: ${message.type}`, 'system');
            }
          } catch (error) {
            console.error('[ElevenLabs] Error processing message:', error);
          }
        });

        elevenLabsWs.on('error', (error) => {
          console.error('[ElevenLabs] WebSocket error:', error);
        });

        elevenLabsWs.on('close', () => {
          console.log('[ElevenLabs] Disconnected');
        });
      } catch (error) {
        console.error('[ElevenLabs] Setup error:', error);
      }
    };

    // Set up ElevenLabs connection
    setupElevenLabs();

    // Handle messages from Twilio
    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        if (msg.event !== 'media') {
          console.log(`[Twilio] Received event: ${msg.event}`);
        }

        switch (msg.event) {
          case 'start':
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            customParameters = msg.start.customParameters; // Store parameters
            phoneNumber = msg.start.customParameters.phone; // Store phone number
            
            console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
            console.log('[Twilio] Start parameters:', customParameters);

            // Initialize Firebase conversation document
            logToFirebase(phoneNumber, 'Call started', 'system');

            // If we have the phone number and ElevenLabs connection is ready, load dynamic variables
            if (phoneNumber && elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
              const storedVariables = retrieveVariables(phoneNumber);
              if (storedVariables) {
                customParameters.dynamic_variables = storedVariables;
                console.log('[Storage] Retrieved dynamic variables for', phoneNumber);
                
                // Get prompt and first_message from storage if available (bridge approach)
                let promptText = 'you are a gary from the phone store';
                let firstMessageText = 'hey there! how can I help you today?';
                
                if (storedVariables.prompt) {
                  promptText = storedVariables.prompt;
                  console.log('[Storage] Retrieved prompt from bridge storage for', phoneNumber);
                }
                
                if (storedVariables.first_message) {
                  firstMessageText = storedVariables.first_message;
                  console.log('[Storage] Retrieved first_message from bridge storage for', phoneNumber);
                }
                
                // Send updated configuration with dynamic variables to ElevenLabs
                const updateConfig = {
                  type: 'conversation_initiation_client_data',
                  dynamic_variables: storedVariables || {},
                  conversation_config_override: {
                    agent: {
                      prompt: {
                        prompt: promptText,
                      },
                      first_message: firstMessageText,
                    },
                  },
                };
                
                elevenLabsWs.send(JSON.stringify(updateConfig));
                console.log('[ElevenLabs] Resent configuration with dynamic variables');
              }
            }
            break;

          case 'media':
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              const audioMessage = {
                user_audio_chunk: Buffer.from(msg.media.payload, 'base64').toString('base64'),
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
            }
            break;

          case 'stop':
            console.log(`[Twilio] Stream ${streamSid} ended`);
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              elevenLabsWs.close();
            }
            break;

          default:
            console.log(`[Twilio] Unhandled event: ${msg.event}`);
        }
      } catch (error) {
        console.error('[Twilio] Error processing message:', error);
      }
    });

    // Handle WebSocket closure
    ws.on('close', () => {
      console.log('[Twilio] Client disconnected');
      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });
  });
});

// Start the Fastify server
fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});
